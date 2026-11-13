#!/usr/bin/env bash
# make verify —— 一条命令出全部交付证据（issue #26）
# 运行：cd 部署目录 && make verify（或 bash scripts/verify.sh）
# 输出五块：1 sha（仓库+部署） 2 healthz 原文 3 settleDay bench
#           4 11 张表 count（全新 seed） 5 migrate 幂等（跑前跑后 count 对比）
#
# 依赖：本机有一个可直连的 Postgres 供「全新 bench 库」用（DROP/CREATE gmd_bench），
#       以及 REPO_DIR 是当前代码的 git clone（sha 与 bench 代码都从这里来）。
set -euo pipefail

# ---- 可覆盖的路径/连接（默认贴合本机 prod 部署）----
REPO_DIR="${REPO_DIR:-/root/gmd/repo}"
HEALTHZ_URL="${HEALTHZ_URL:-http://127.0.0.1/healthz}"
APP_CONTAINER="${APP_CONTAINER:-prod-app-1}"          # 读部署 sha 用
PG_CONTAINER="${PG_CONTAINER:-gmd-pg}"                 # bench 库所在 Postgres 容器
PG_USER="${PG_USER:-gmd}"
BENCH_DB="${BENCH_DB:-gmd_bench}"
BENCH_DB_URL="${BENCH_DB_URL:-postgres://gmd:gmd_dev_pw@127.0.0.1:55432/gmd_bench}"
BENCH_N="${BENCH_N:-20}"
# bench 期间把赛季长度抬到远大于 N，避免 settleDay 触发赛季末重置而污染计时
BENCH_SEASON_DAYS="${BENCH_SEASON_DAYS:-1000}"

die() { echo "verify 失败: $*" >&2; exit 1; }

# 在 REPO_DIR 里用 tsx 跑 src 下的脚本（env 只带 DATABASE_URL，不碰 .env）
run_ts() { (cd "$REPO_DIR" && DATABASE_URL="$BENCH_DB_URL" node --import tsx "$@"); }

# 建/重建一个全新 bench 库
fresh_bench() {
  docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres \
    -c "DROP DATABASE IF EXISTS $BENCH_DB WITH (FORCE);" \
    -c "CREATE DATABASE $BENCH_DB;" >/dev/null \
    || die "建 bench 库 $BENCH_DB 失败（容器 $PG_CONTAINER）"
  run_ts src/db/migrate.ts >/dev/null || die "migrate 失败"
  run_ts src/db/seed.ts >/dev/null || die "seed 失败"
}

echo "============================================================"
echo "make verify —— 交付证据（issue #26）"
echo "时间 $(date '+%F %T %z')  节点 $(hostname)"
echo "============================================================"

# ---------- 1. git rev-parse HEAD ----------
echo
echo "== 1. git rev-parse HEAD（仓库 + 部署）=="
if [ -d "$REPO_DIR/.git" ]; then
  echo "仓库  $REPO_DIR : $(git -C "$REPO_DIR" rev-parse HEAD)"
  dirty="$(git -C "$REPO_DIR" status --porcelain)"
  if [ -n "$dirty" ]; then
    echo "  ! 工作区有未提交改动（sha 只代表提交，不代表工作区）："
    echo "$dirty" | sed 's/^/    /'
  else
    echo "  工作区干净"
  fi
else
  echo "仓库  $REPO_DIR : 不是 git 仓库"
fi
DEPLOY_SHA="$(docker exec "$APP_CONTAINER" cat /app/git-sha 2>/dev/null || true)"
if [ -n "$DEPLOY_SHA" ]; then
  echo "部署  $APP_CONTAINER(/app/git-sha) : $DEPLOY_SHA"
else
  echo "部署  $APP_CONTAINER(/app/git-sha) : n/a（镜像未 bake git-sha，重建后才有）"
fi

# ---------- 2. healthz 原文 ----------
echo
echo "== 2. curl -s $HEALTHZ_URL =="
curl -s "$HEALTHZ_URL" || die "healthz 请求失败（$HEALTHZ_URL）"
echo

# ---------- 3. settleDay bench ----------
echo
echo "== 3. settleDay bench（$BENCH_N 天，全新 bench 库，SEASON_DAYS=$BENCH_SEASON_DAYS）=="
fresh_bench
(cd "$REPO_DIR" && DATABASE_URL="$BENCH_DB_URL" SEASON_DAYS="$BENCH_SEASON_DAYS" \
  node --import tsx src/game/bench.ts "$BENCH_N") || die "bench 失败"

# ---------- 4. 11 张表 count（全新 seed）----------
echo
echo "== 4. 11 张表 count（全新 seed）=="
fresh_bench
(cd "$REPO_DIR" && DATABASE_URL="$BENCH_DB_URL" node scripts/verify-counts.mjs) || die "count 失败"

# ---------- 5. migrate 幂等 ----------
echo
echo "== 5. migrate 幂等（跑前 / 跑后 count 对比）=="
BEFORE="$(mktemp)"; AFTER="$(mktemp)"
trap 'rm -f "$BEFORE" "$AFTER"' EXIT
(cd "$REPO_DIR" && DATABASE_URL="$BENCH_DB_URL" node scripts/verify-counts.mjs) > "$BEFORE" || die "count(跑前) 失败"
echo "-- migrate 前 --"
cat "$BEFORE"
run_ts src/db/migrate.ts >/dev/null || die "migrate 失败"
(cd "$REPO_DIR" && DATABASE_URL="$BENCH_DB_URL" node scripts/verify-counts.mjs) > "$AFTER" || die "count(跑后) 失败"
echo "-- migrate 后 --"
cat "$AFTER"
if diff -u "$BEFORE" "$AFTER" >/dev/null; then
  echo "migrate 幂等: PASS（跑前跑后 11 张表 count 完全一致）"
else
  echo "migrate 幂等: FAIL（差异如下）"
  diff -u "$BEFORE" "$AFTER" || true
  exit 1
fi

echo
echo "============================================================"
echo "verify 完成"
echo "============================================================"
