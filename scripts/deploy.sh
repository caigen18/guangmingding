#!/usr/bin/env bash
# 光明顶 v1 部署脚本（#27）：把「线上镜像 = 哪个 commit」钉死。
#
# 流程：
#   0) 门禁：REPO_DIR 必须 checkout 在 main 且与 origin/main 一致（先 fetch），否则拒绝部署
#   1) 打印并记录 commit sha（full + short + branch + origin/main sha）到 backups/deploy.log（含时间）
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

# ---- 门禁（#27 收口）：只允许从 main 部署，且本地 HEAD 必须与 origin/main 一致 ----
# 先 fetch，拿到最新的 origin/main；fetch 失败（无网络/远端不可达）也直接拒绝。
if ! git -C "$REPO_DIR" fetch origin --quiet; then
  echo "[deploy] 门禁未通过：git fetch origin 失败，无法确认与远端一致，拒绝部署。" >&2
  exit 1
fi

BRANCH_NAME="$(git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo detached)"
HEAD_SHA="$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null || echo none)"
MAIN_SHA="$(git -C "$REPO_DIR" rev-parse origin/main 2>/dev/null || echo none)"

if [ "$BRANCH_NAME" != "main" ] || [ "$HEAD_SHA" != "$MAIN_SHA" ]; then
  echo "[deploy] 门禁未通过：HEAD 不在 main 或与 origin/main 不一致，拒绝部署。" >&2
  echo "  branch      = $BRANCH_NAME (要求 main)" >&2
  echo "  HEAD        = $HEAD_SHA" >&2
  echo "  origin/main = $MAIN_SHA" >&2
  exit 1
fi

SHA="$HEAD_SHA"
SHORT="$(git -C "$REPO_DIR" rev-parse --short HEAD)"
BRANCH="$BRANCH_NAME"

cd "$COMPOSE_DIR"
mkdir -p "$(dirname "$DEPLOY_LOG")"

# 部署前取当前 app 容器的镜像 tag 作为回滚点（无则留空）
PREV=""
APP_CID="$(docker compose ps -q app 2>/dev/null | head -1 || true)"
if [ -n "$APP_CID" ]; then
  PREV="$(docker inspect --format '{{.Config.Image}}' "$APP_CID" 2>/dev/null || true)"
fi

# 部署前记录一条：完整 sha + short + branch + origin/main sha + 时间（追加，不覆盖）；有上一镜像时带 prev=
LOG_LINE="$(date -Is) sha=$SHA short=$SHORT branch=$BRANCH main_sha=$MAIN_SHA"
[ -n "$PREV" ] && LOG_LINE="$LOG_LINE prev=$PREV"
echo "$LOG_LINE" >> "$DEPLOY_LOG"
echo "[deploy] $LOG_LINE"

# 用 sha 打 tag 构建 + 起全
export GIT_SHA="$SHORT"
docker compose build --build-arg "GIT_SHA=$SHORT"
docker compose up -d

echo "[deploy] done. image=gmd-app:$SHORT  (healthz sha 应同为 $SHORT)"
