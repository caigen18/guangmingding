# 光明顶 v1 部署（单机 docker compose）

## 起全套
```bash
git clone <repo> && cd guangmingding
cp .env.example .env          # 只填非密钥：POSTGRES_DB/USER、HTTP_PORT、SEASON_DAYS……
./scripts/init-secrets.sh     # 生成 .secrets/{db_password,admin_pass,ai_api_key}（0440，git 忽略）
docker compose up -d --build  # db → migrate(一次性) → app → caddy
```
`docker compose ps` 应看到 db healthy、migrate Exited(0)、app healthy、caddy running。

## 健康检查
```bash
curl -s http://127.0.0.1/healthz     # {"ok":true,"uptimeMs":…,"db":"up"}
```

## 备份 / 恢复
```bash
./scripts/backup.sh    # pg_dump -Fc → ./backups/gmd-*.dump，保留 14 天（可挂 cron: 0 3 * * *）
./scripts/restore.sh   # 恢复到临时库，校验 11 表 + cities 数，然后删临时库
```

## 密钥
DB 密码 / ADMIN_PASS / AI_API_KEY 只存在于 `.secrets/` 文件里，以 compose secrets 挂进容器 `/run/secrets/*`，
由 `docker/entrypoint.sh` 读成环境变量。`docker inspect`、`docker compose config` 里看不到明文。
db 密码只能首次生成：卷已初始化后要改，先进库 `ALTER USER` 再换文件。

## 两个坑
- compose 里覆盖 `entrypoint:` 会清空镜像 CMD（容器秒退 0）；需要时显式写 `command:`。
- 这台机器 `docker exec` 喂 stdin 不生效，恢复用 `docker cp` 进容器再 `pg_restore`（restore.sh 已这么做）。
