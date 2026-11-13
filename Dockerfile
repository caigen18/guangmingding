# 光明顶 v1 后端镜像：多阶段 build → node:20-slim 运行
# 构建：docker build -t gmd-app .   （生产编排见 docker-compose.yml）

# ---------- 1. 构建阶段：装全量依赖 + tsc 编译 + 剪掉 devDependencies ----------
FROM node:20-slim AS build
WORKDIR /app
ENV NODE_ENV=development
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev && npm cache clean --force

# ---------- 2. 运行阶段 ----------
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    PORT=3000
# 部署 sha（issue #26）：build 时由 docker compose 的 build.args 传入，写成文件供 make verify 读
ARG GIT_SHA=unknown
ENV GIT_SHA=$GIT_SHA
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY db ./db
RUN printf '%s' "$GIT_SHA" > /app/git-sha && chown node:node /app/git-sha
COPY docker/entrypoint.sh /usr/local/bin/entrypoint
RUN chmod +x /usr/local/bin/entrypoint
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/local/bin/entrypoint"]
CMD ["node", "dist/server/main.js"]
