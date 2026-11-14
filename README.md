# 光明顶（guangmingding）

多人同服文字经营游戏 v1 后端。Node 20 + TypeScript、Fastify、原生 ws、Postgres 16、node-cron + advisory lock、服务端渲染 HTML。

## 开发

```bash
cp .env.example .env          # DATABASE_URL 指向本地 Postgres 16
npm install
npm run migrate               # 幂等建表（11 张表）
npm run seed                  # 20 个测试城市
npm run dev                   # http://127.0.0.1:3002/healthz（.env 里 PORT=3002）
```

## 脚本

| 命令 | 作用 |
| --- | --- |
| `npm run build` | tsc 编译到 dist/ |
| `npm run start` | 跑编译产物（端口取 PORT 环境变量） |
| `npm run migrate` | 执行 db/schema.sql（可重复执行） |
| `npm run seed` | 执行 db/seed.sql（20 城，可重复执行） |
| `npm run lint` | eslint |
| `npm run typecheck` | tsc --noEmit |

## make verify（P0 门禁 #26）

一条命令打印全部交付证据：commit sha + /healthz 原文 + settleDay bench（p50/p95/max/over_2000ms）+ prod 库 11 张表 count（只读）。先 `npm install`，再：

```bash
make verify
```

输出可直接贴进任务评论当证据，不需要手改数字。它：

- 用 `git rev-parse HEAD` 打当前 sha（任何人凭该 sha 复现同一组数）；
- `curl` 打 `/healthz` 原文；
- 起一个一次性 `postgres:16` 容器跑 migrate + seed + bench（写操作全在 throwaway 库，不碰 prod），并顺带做 migrate 幂等自检（两次 migrate 前后 11 表 count 一致）；
- 只读 `docker compose exec db` 数 prod 的 11 张表 count，不做任何写。

可覆盖环境变量（均有安全默认值）：`HEALTHZ_URL`、`PROD_COMPOSE_FILE`（默认 `/root/gmd/prod/docker-compose.yml`）、`PROD_DB_USER`、`PROD_DB_NAME`、`BENCH_IMAGE`、`BENCH_PORT`。

## 目录

```
src/config     配置与游戏常数（M7 起 zod 校验）
src/db         pool / migrate / seed
src/routes     HTTP 路由（服务端渲染页面、/healthz）
src/server     Fastify 应用与启动
src/ws         WebSocket 广播中心（M8）
db             schema.sql / seed.sql
```

## 已验证（M5）

Postgres 16.16 空库上实测：`migrate` 连续两次均建成 11 张表、无报错；`seed` 连续两次后 `cities = 20`；`npm run build` 通过；启动后 `GET /healthz` 返回 200 `{"ok":true,...}`。
