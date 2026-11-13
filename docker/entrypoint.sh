#!/bin/sh
# 光明顶 v1 后端容器入口：/run/secrets/* → 环境变量 → 等 DB → 起服务。
# 密钥以 compose secrets 文件挂进 /run/secrets（scripts/init-secrets.sh 生成），
# 不写进 environment，所以 docker inspect / docker compose config 里看不到。
# 已在环境里的同名变量优先（本机裸跑 npm run dev / 旧 env 方式照常工作）。
set -eu

read_secret() { [ -f "$1" ] || return 0; tr -d '\r\n' <"$1"; }

if [ -z "${DATABASE_URL:-}" ] && [ -f /run/secrets/db_password ]; then
  _pw="$(read_secret /run/secrets/db_password)"
  DATABASE_URL="postgres://${POSTGRES_USER:-gmd}:${_pw}@db:5432/${POSTGRES_DB:-gmd}"
  export DATABASE_URL
  unset _pw
fi
if [ -z "${ADMIN_PASS:-}" ] && [ -f /run/secrets/admin_pass ]; then
  ADMIN_PASS="$(read_secret /run/secrets/admin_pass)"; export ADMIN_PASS
fi
if [ -z "${AI_API_KEY:-}" ] && [ -f /run/secrets/ai_api_key ]; then
  AI_API_KEY="$(read_secret /run/secrets/ai_api_key)"; export AI_API_KEY
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo '[entrypoint] DATABASE_URL 未设置：既没有环境变量，也没有 /run/secrets/db_password' >&2
  exit 1
fi

echo '[entrypoint] waiting for postgres...'
until node -e 'const {Client}=require("pg");const c=new Client({connectionString:process.env.DATABASE_URL});c.connect().then(()=>c.end()).then(()=>process.exit(0)).catch(()=>process.exit(1))' 2>/dev/null; do
  sleep 2
done

echo '[entrypoint] starting app'
exec "$@"
