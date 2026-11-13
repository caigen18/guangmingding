#!/bin/sh
# 光明顶 v1 后端容器入口：等 DB → 建表 →（可选）seed → 起服务。
# migrate / seed 幂等，可重复执行；SEED_ON_BOOT=true 时写入 20 个测试城市。
set -eu

echo '[entrypoint] waiting for postgres...'
until node -e 'const {Client}=require("pg");const c=new Client({connectionString:process.env.DATABASE_URL});c.connect().then(()=>{c.end();process.exit(0)}).catch(()=>process.exit(1));'; do
  echo '[entrypoint] db not ready, retry in 2s'
  sleep 2
done

echo '[entrypoint] migrate (idempotent)'
node dist/db/migrate.js

if [ "${SEED_ON_BOOT:-false}" = "true" ]; then
  echo '[entrypoint] seed (idempotent)'
  node dist/db/seed.js
fi

echo '[entrypoint] starting app'
exec "$@"
