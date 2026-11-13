#!/usr/bin/env bash
# 首次部署：生成 compose secrets 用的文件（默认 .secrets/，0440，属主 1000:1000 = 容器内 node 用户）
# 用法：./scripts/init-secrets.sh [目录，默认 .secrets]
#  - db_password 只在空数据库首次初始化前有意义；库卷已建好后再换，必须先进库 ALTER USER
#  - 密码用十六进制，避免 DATABASE_URL 里出现需要 URL 转义的字符
set -euo pipefail

DIR="${1:-.secrets}"
APP_UID="${APP_UID:-1000}"
APP_GID="${APP_GID:-1000}"

mkdir -p "$DIR"
umask 077

gen() { # $1 = 文件名, $2 = 字节数
  local f="$DIR/$1"
  if [ -s "$f" ]; then
    echo "skip: $f 已存在（不覆盖）"
    return 0
  fi
  openssl rand -hex "$2" > "$f"
  echo "wrote $f ($(wc -c < "$f") bytes)"
}

gen db_password 16
gen admin_pass 16
: > "$DIR/ai_api_key"          # 可选，空 = 模板兜底
echo "wrote $DIR/ai_api_key (0 bytes，需要时把 key 写进去)"

chmod 440 "$DIR"/* 2>/dev/null || true
if [ "$(id -u)" = "0" ]; then
  chown "$APP_UID:$APP_GID" "$DIR"/* 2>/dev/null || true
fi
chmod 750 "$DIR"

echo
echo "完成。.env 里不再需要 POSTGRES_PASSWORD / ADMIN_PASS / AI_API_KEY（写了也不生效，入口只读文件）。"
echo "db_password 只在首次生成：卷已初始化后再改文件，要先 ALTER USER 改库里的密码，否则 app 连不上。"
