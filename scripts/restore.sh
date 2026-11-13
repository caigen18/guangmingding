#!/usr/bin/env bash
# 恢复验证：把 dump 恢复到临时库，数一下城市，再删掉临时库（不动生产库）
# 用法：cd /root/gmd/prod && ./scripts/restore.sh [dump文件]   # 不带参数用最新一个
# 注意：本机 `docker compose exec -T` 喂 stdin 不生效（pg_restore 报 "input file is too short"），
#       所以 dump 先 docker cp 进容器再按路径 pg_restore。
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; [ -f .env ] && . ./.env; set +a

BACKUP_DIR="${BACKUP_DIR:-./backups}"
DUMP="${1:-$(ls -t "${BACKUP_DIR}"/gmd-*.dump 2>/dev/null | head -1)}"
if [ -z "${DUMP}" ] || [ ! -f "${DUMP}" ]; then
  echo "no dump found under ${BACKUP_DIR}" >&2
  exit 1
fi

DB="${POSTGRES_DB:-gmd}"
USER="${POSTGRES_USER:-gmd}"
CHECK="${DB}_restore_check"
DB_CID="$(docker compose ps -q db)"
[ -n "${DB_CID}" ] || { echo "db container not running" >&2; exit 1; }

echo "restore check: ${DUMP} -> temp db ${CHECK} (container ${DB_CID:0:12})"
docker compose exec -T db dropdb -U "${USER}" --if-exists "${CHECK}" >/dev/null 2>&1 || true
docker compose exec -T db createdb -U "${USER}" "${CHECK}"
docker cp "${DUMP}" "${DB_CID}:/tmp/restore_check.dump"
docker compose exec -T db pg_restore -U "${USER}" -d "${CHECK}" --clean --if-exists /tmp/restore_check.dump
docker compose exec -T db rm -f /tmp/restore_check.dump
echo "--- tables in ${CHECK} ---"
docker compose exec -T db psql -U "${USER}" -d "${CHECK}" -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE';"
echo "--- cities in ${CHECK} ---"
docker compose exec -T db psql -U "${USER}" -d "${CHECK}" -Atc "SELECT count(*) FROM cities;"
docker compose exec -T db dropdb -U "${USER}" "${CHECK}"
echo "restore check passed, temp db ${CHECK} dropped"
