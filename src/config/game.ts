/**
 * 全局配置与游戏常数入口。
 * M7（issue #17）会把这里改成 zod 校验的单一来源，改一个数全链路生效；
 * 目前只收 M5 需要的环境变量和基础常数。
 */

const env = process.env;

export const config = {
  databaseUrl: env.DATABASE_URL ?? 'postgres://gmd:gmd_dev_pw@127.0.0.1:55432/gmd',
  port: Number(env.PORT ?? 3000),
  nodeEnv: env.NODE_ENV ?? 'development',
  tz: env.TZ ?? 'Asia/Shanghai',
  seasonDays: Number(env.SEASON_DAYS ?? 60),
  ai: {
    apiKey: env.AI_API_KEY ?? '',
    model: env.AI_MODEL ?? '',
    autoPublish: env.AI_AUTO_PUBLISH === 'true',
  },
  admin: {
    user: env.ADMIN_USER ?? 'admin',
    pass: env.ADMIN_PASS ?? '',
  },
} as const;

/** 货物 key（事件与市场事件里只放 key，中文名走 UI 映射） */
export const GOODS = ['grain', 'wood', 'stone', 'iron', 'cloth'] as const;
export type Good = (typeof GOODS)[number];

/** 城市初始资源 */
export const STARTING_RESOURCES: Record<Good, number> = {
  grain: 120,
  wood: 80,
  stone: 60,
  iron: 20,
  cloth: 30,
};

export const STARTING_POPULATION = 100;
export const STARTING_HAPPINESS = 60;
export const CITY_COUNT = 20;
