#!/usr/bin/env bash
# make verify —— 一条命令打印 #26 全部交付证据。
#
# 输出四块（外加 migrate 幂等自检）：
#   1) 当前 commit sha（仓库 HEAD，任何人凭该 sha 复现同一组数）
#   2) /healthz 原文
#   3) settleDay bench：一次性 throwaway Postgres 里 migrate+seed+bench，
#      统计 p50/p95/max/over_2000ms（写操作全在 throwaway 库，不碰 prod）
#   4) prod 库 11 张表 count（只读 SELECT count）
#   +) migrate 幂等：bench 库里 migrate 两次，前后 11 表 count 对比
#
# 用法（仓库根目录）：
#   npm install && make verify
#
# 依赖：docker（起一次性 bench 库 + 连 prod db 只读 count）、能 curl 到 healthz。
# 可覆盖环境变量：HEALTHZ_URL / PROD_COMPOSE_FILE / PROD_DB_USER / PROD_DB_NAME / BENCH_IMAGE / BENCH_PORT
set -euo pipefail

REPO_DIR="$(git rev-parse --show-toplevel)"

HEALTHZ_URL="${HEALTHZ_URL:-http://127.0.0.1/healthz}"
PROD_COMPOSE_FILE="${PROD_COMPOSE_FILE:-/root/gmd/prod/docker-compose.yml}"
PROD_DB_USER="${PROD_DB_USER:-gmd}"
PROD_DB_NAME="${PROD_DB_NAME:-gmd}"
BENCH_IMAGE="${BENCH_IMAGE:-postgres:16}"
BENCH_PORT="${BENCH_PORT:-55444}"
BENCH_DB="gmd_verify"
BENCH_USER="gmd"
BENCH_PW="gmd_verify_pw"

COUNT_SQL="SELECT 'seasons', count(*) FROM seasons
UNION ALL SELECT 'players', count(*) FROM players
UNION ALL SELECT 'cities', count(*) FROM cities
UNION ALL SELECT 'buildings', count(*) FROM buildings
UNION ALL SELECT 'assignments', count(*) FROM assignments
UNION ALL SELECT 'events', count(*) FROM events
UNION ALL SELECT 'city_events', count(*) FROM city_events
UNION ALL SELECT 'day_logs', count(*) FROM day_logs
UNION ALL SELECT 'market_prices', count(*) FROM market_prices
UNION ALL SELECT 'trades', count(*) FROM trades
UNION ALL SELECT 'ai_calls', count(*) FROM ai_calls
ORDER BY 1;"

hr() { printf '\n===== %s =====\n' "$1"; }

echo "verify started $(date -Is)"
echo "node=$(node -v) docker=$(docker -v | cut -d' ' -f3 | tr -d ',')"

hr "1) commit sha"
echo "repo_sha=$(git -C "$REPO_DIR" rev-parse HEAD)"
echo "repo_short=$(git -C "$REPO_DIR" rev-parse --short HEAD)"
echo "repo_branch=$(git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD)"

hr "2) healthz"
curl -sS --max-time 5 "$HEALTHZ_URL"
printf '\n'

hr "3) settleDay bench (throwaway Postgres，不碰 prod)"
BENCH_CID=""
cleanup() { if [ -n "$BENCH_CID" ]; then docker rm -f "$BENCH_CID" >/dev/null 2>&1 || true; fi; }
trap cleanup EXIT

BENCH_CID="$(docker run -d --rm --name "gmd-verify-bench-$$" \
  -e POSTGRES_USER="$BENCH_USER" -e POSTGRES_PASSWORD="$BENCH_PW" -e POSTGRES_DB="$BENCH_DB" \
  -p "127.0.0.1:$BENCH_PORT:5432" "$BENCH_IMAGE")"
echo "bench_container=$BENCH_CID"

echo "waiting bench postgres..."
for _ in $(seq 1 60); do
  if docker exec "$BENCH_CID" pg_isready -U "$BENCH_USER" -d "$BENCH_DB" >/dev/null 2>&1; then break; fi
  sleep 0.5
done
docker exec "$BENCH_CID" pg_isready -U "$BENCH_USER" -d "$BENCH_DB"

export DATABASE_URL="postgres://$BENCH_USER:$BENCH_PW@127.0.0.1:$BENCH_PORT/$BENCH_DB"
cd "$REPO_DIR"

bench_count() { docker exec "$BENCH_CID" psql -U "$BENCH_USER" -d "$BENCH_DB" -t -A -c "$COUNT_SQL"; }

echo "-- migrate (1/2) --"
node --import tsx src/db/migrate.ts
echo "-- seed --"
node --import tsx src/db/seed.ts
echo "-- migrate 幂等 (2/2)：前后 11 表 count 对比 --"
count_before="$(bench_count)"
node --import tsx src/db/migrate.ts
count_after="$(bench_count)"
echo "count_before:"
echo "$count_before"
echo "count_after:"
echo "$count_after"
if [ "$count_before" = "$count_after" ]; then
  echo "migrate_idempotent=yes"
else
  echo "migrate_idempotent=no"
fi
echo "-- bench:settle 20 --"
node --import tsx src/game/bench.ts 20

hr "4) prod 11 表 count（只读）"
docker compose -f "$PROD_COMPOSE_FILE" exec -T db \
  psql -U "$PROD_DB_USER" -d "$PROD_DB_NAME" -t -A -c "$COUNT_SQL"

echo
echo "verify done $(date -Is)"
