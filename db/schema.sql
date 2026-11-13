-- 光明顶 v1 建表脚本
-- 幂等：可重复执行（CREATE TABLE/INDEX IF NOT EXISTS），不删除已有数据。
-- 11 张表：seasons players cities buildings assignments events city_events
--          day_logs market_prices trades ai_calls

BEGIN;

-- 1. 赛季（一个赛季一个世界）
CREATE TABLE IF NOT EXISTS seasons (
  id          bigserial PRIMARY KEY,
  season_no   integer     NOT NULL UNIQUE,
  name        text        NOT NULL,
  current_day integer     NOT NULL DEFAULT 1,
  status      text        NOT NULL DEFAULT 'active',
  starts_at   timestamptz NOT NULL DEFAULT now(),
  ends_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT seasons_status_chk CHECK (status IN ('pending', 'active', 'ended')),
  CONSTRAINT seasons_day_chk CHECK (current_day >= 1)
);

-- 2. 玩家
CREATE TABLE IF NOT EXISTS players (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text        NOT NULL UNIQUE,
  pass_hash    text        NOT NULL DEFAULT '',
  role         text        NOT NULL DEFAULT 'player',
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  CONSTRAINT players_role_chk CHECK (role IN ('player', 'admin'))
);

-- 3. 城市（每玩家一座）
CREATE TABLE IF NOT EXISTS cities (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id  bigint      NOT NULL REFERENCES seasons (id) ON DELETE CASCADE,
  player_id  uuid        REFERENCES players (id) ON DELETE SET NULL,
  name       text        NOT NULL,
  x          integer     NOT NULL DEFAULT 0,
  y          integer     NOT NULL DEFAULT 0,
  population numeric(12, 2) NOT NULL DEFAULT 100,
  happiness  numeric(5, 2)  NOT NULL DEFAULT 60,
  resources  jsonb       NOT NULL DEFAULT '{}'::jsonb,
  version    integer     NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cities_name_uniq UNIQUE (season_id, name),
  CONSTRAINT cities_population_chk CHECK (population >= 0),
  CONSTRAINT cities_happiness_chk CHECK (happiness >= 0 AND happiness <= 100)
);

-- 4. 建筑
CREATE TABLE IF NOT EXISTS buildings (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  city_id    uuid        NOT NULL REFERENCES cities (id) ON DELETE CASCADE,
  key        text        NOT NULL,
  level      integer     NOT NULL DEFAULT 1,
  slot       integer     NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT buildings_uniq UNIQUE (city_id, key),
  CONSTRAINT buildings_level_chk CHECK (level >= 1)
);

-- 5. 人口分配（今日多少人口派到哪座建筑干活）
CREATE TABLE IF NOT EXISTS assignments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  city_id    uuid        NOT NULL REFERENCES cities (id) ON DELETE CASCADE,
  building_id uuid       NOT NULL REFERENCES buildings (id) ON DELETE CASCADE,
  day        integer     NOT NULL,
  workers    integer     NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assignments_uniq UNIQUE (city_id, building_id, day),
  CONSTRAINT assignments_workers_chk CHECK (workers >= 0)
);

-- 6. 事件模板 / 生成出的事件本体
CREATE TABLE IF NOT EXISTS events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id    bigint      NOT NULL REFERENCES seasons (id) ON DELETE CASCADE,
  template_key text        NOT NULL,
  title        text        NOT NULL,
  body         text        NOT NULL DEFAULT '',
  severity     text        NOT NULL DEFAULT 'normal',
  choices      jsonb       NOT NULL DEFAULT '[]'::jsonb,
  generated_by text        NOT NULL DEFAULT 'template',
  created_day  integer     NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT events_severity_chk CHECK (severity IN ('low', 'normal', 'high')),
  CONSTRAINT events_generated_by_chk CHECK (generated_by IN ('ai', 'template'))
);

-- 7. 城市事件实例（每城每日 <= 1 条业务约束）
CREATE TABLE IF NOT EXISTS city_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  city_id      uuid        NOT NULL REFERENCES cities (id) ON DELETE CASCADE,
  event_id     uuid        NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  day          integer     NOT NULL,
  expires_day  integer     NOT NULL,
  status       text        NOT NULL DEFAULT 'pending',
  choice_key   text,
  effects      jsonb,
  resolved_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT city_events_uniq UNIQUE (city_id, day, event_id),
  CONSTRAINT city_events_status_chk CHECK (status IN ('pending', 'resolved', 'expired'))
);

-- 8. 日结日志（settleDay 跑一次写一条，带实测耗时）
CREATE TABLE IF NOT EXISTS day_logs (
  id             bigserial PRIMARY KEY,
  season_id      bigint      NOT NULL REFERENCES seasons (id) ON DELETE CASCADE,
  day            integer     NOT NULL,
  settled_at     timestamptz NOT NULL DEFAULT now(),
  duration_ms    integer     NOT NULL,
  cities_settled integer     NOT NULL,
  summary        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT day_logs_uniq UNIQUE (season_id, day),
  CONSTRAINT day_logs_duration_chk CHECK (duration_ms >= 0)
);

-- 9. 市场价格
CREATE TABLE IF NOT EXISTS market_prices (
  id         bigserial PRIMARY KEY,
  season_id  bigint        NOT NULL REFERENCES seasons (id) ON DELETE CASCADE,
  day        integer       NOT NULL,
  good       text          NOT NULL,
  price      numeric(10, 2) NOT NULL,
  prev_price numeric(10, 2) NOT NULL,
  delta_pct  numeric(8, 2)  NOT NULL DEFAULT 0,
  created_at timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT market_prices_uniq UNIQUE (season_id, day, good),
  CONSTRAINT market_prices_price_chk CHECK (price > 0)
);

-- 10. 城市间交易
CREATE TABLE IF NOT EXISTS trades (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id       bigint      NOT NULL REFERENCES seasons (id) ON DELETE CASCADE,
  from_city_id    uuid        NOT NULL REFERENCES cities (id) ON DELETE CASCADE,
  to_city_id      uuid        NOT NULL REFERENCES cities (id) ON DELETE CASCADE,
  give            jsonb       NOT NULL DEFAULT '[]'::jsonb,
  take            jsonb       NOT NULL DEFAULT '[]'::jsonb,
  status          text        NOT NULL DEFAULT 'pending',
  created_day     integer     NOT NULL,
  expires_day     integer     NOT NULL,
  resolved_at     timestamptz,
  resolved_by     uuid        REFERENCES players (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trades_status_chk CHECK (status IN ('pending', 'accepted', 'declined', 'expired', 'cancelled')),
  CONSTRAINT trades_distinct_cities_chk CHECK (from_city_id <> to_city_id)
);

-- 11. AI 调用成本记账
CREATE TABLE IF NOT EXISTS ai_calls (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id         bigint        REFERENCES seasons (id) ON DELETE SET NULL,
  day               integer,
  purpose           text          NOT NULL DEFAULT 'event_gen',
  model             text,
  prompt_tokens     integer       NOT NULL DEFAULT 0,
  completion_tokens integer       NOT NULL DEFAULT 0,
  cost_usd          numeric(12, 6) NOT NULL DEFAULT 0,
  latency_ms        integer       NOT NULL DEFAULT 0,
  ok                boolean       NOT NULL DEFAULT true,
  fallback          boolean       NOT NULL DEFAULT false,
  error             text,
  created_at        timestamptz   NOT NULL DEFAULT now()
);

-- 索引
CREATE INDEX IF NOT EXISTS cities_season_idx ON cities (season_id);
CREATE INDEX IF NOT EXISTS cities_player_idx ON cities (player_id);
CREATE INDEX IF NOT EXISTS buildings_city_idx ON buildings (city_id);
CREATE INDEX IF NOT EXISTS assignments_day_idx ON assignments (day);
CREATE INDEX IF NOT EXISTS city_events_city_day_idx ON city_events (city_id, day);
CREATE INDEX IF NOT EXISTS city_events_status_idx ON city_events (status);
CREATE INDEX IF NOT EXISTS market_prices_day_idx ON market_prices (season_id, day);
CREATE INDEX IF NOT EXISTS trades_to_city_idx ON trades (to_city_id, status);
CREATE INDEX IF NOT EXISTS trades_from_city_idx ON trades (from_city_id, status);
CREATE INDEX IF NOT EXISTS ai_calls_created_idx ON ai_calls (created_at);

COMMIT;
