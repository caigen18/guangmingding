#!/usr/bin/env bash
# 光明顶 v1 部署脚本（#27）：把「线上镜像 = 哪个 commit」钉死。
#
# 流程：
#   1) 打印并记录当前 commit sha（full + short + branch）到 backups/deploy.log（含时间）
#   2) 用 --build-arg GIT_SHA=<short> 构建镜像，tag = gmd-app:<short>
#   3) docker compose up -d
# 之后 /healthz 的 sha 字段 == 镜像 tag == 本次记录的 short sha。
#
# 用法（在 compose 所在目录）：
#   ./scripts/deploy.sh                # REPO_DIR 默认 = git 仓库根
#   REPO_DIR=../repo ./scripts/deploy.sh   # 部署配置目录不是 git 仓库时，显式指到源码仓库
set -euo pipefail

# 源码仓库根：默认取当前 git 仓库根；部署配置目录（如 /root/gmd/prod）不是仓库时用 REPO_DIR 覆盖
if [ -n "${REPO_DIR:-}" ]; then
  REPO_DIR="$(cd "$REPO_DIR" && pwd)"
else
  REPO_DIR="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
fi

COMPOSE_DIR="${COMPOSE_DIR:-.}"
DEPLOY_LOG="${DEPLOY_LOG:-backups/deploy.log}"

SHA="$(git -C "$REPO_DIR" rev-parse HEAD)"
SHORT="$(git -C "$REPO_DIR" rev-parse --short HEAD)"
BRANCH="$(git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo detached)"

cd "$COMPOSE_DIR"
mkdir -p "$(dirname "$DEPLOY_LOG")"

# 部署前记录一条：完整 sha + short + 时间（追加，不覆盖）
echo "$(date -Is) sha=$SHA short=$SHORT branch=$BRANCH" >> "$DEPLOY_LOG"
echo "[deploy] $(date -Is) sha=$SHA short=$SHORT branch=$BRANCH"

# 用 sha 打 tag 构建 + 起全
export GIT_SHA="$SHORT"
docker compose build --build-arg "GIT_SHA=$SHORT"
docker compose up -d

echo "[deploy] done. image=gmd-app:$SHORT  (healthz sha 应同为 $SHORT)"
