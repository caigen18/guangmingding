#!/usr/bin/env bash
# 每日 pg_dump 备份：落宿主机目录 + 可选 S3，保留 14 天
# 用法：cd /root/gmd/prod && ./scripts/backup.sh
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; [ -f .env ] && . ./.env; set +a

BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"
FILE="${BACKUP_DIR}/gmd-${STAMP}.dump"

mkdir -p "${BACKUP_DIR}"

# 从 db 容器内 dump（pg_dump 与 pg 同版本 16；-Fc 自定义格式，恢复友好）
docker compose exec -T db pg_dump -U "${POSTGRES_USER:-gmd}" -d "${POSTGRES_DB:-gmd}" -Fc > "${FILE}"
SIZE="$(du -h "${FILE}" | cut -f1)"
echo "backup ok: ${FILE} (${SIZE})"

# 可选：S3 兼容对象存储（有 S3_BUCKET + rclone 时启用，否则跳过）
if [ -n "${S3_BUCKET:-}" ] && command -v rclone >/dev/null 2>&1; then
  rclone copy "${FILE}" "${S3_REMOTE:-s3}:${S3_BUCKET}/backups/" && echo "s3 upload ok"
fi

# 保留最近 N 天
find "${BACKUP_DIR}" -name 'gmd-*.dump' -mtime "+${RETENTION_DAYS}" -delete
echo "pruned to last ${RETENTION_DAYS} days"
