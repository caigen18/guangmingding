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
