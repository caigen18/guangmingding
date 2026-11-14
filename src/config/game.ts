import { z } from 'zod';

/**
 * 全局配置与游戏常数入口。
 * M7（issue #17）：环境变量经 zod 校验（缺字段 / 类型错 / 超范围，启动即报错），
 * 游戏常数全部集中在本文件，settleDay、seed、接口、前端展示口径都读这一处，改一个数全链路生效。
 */

/** 赛季默认天数（SEASON_DAYS 环境变量可覆盖） */
const DEFAULT_SEASON_DAYS = 10;

/**
 * env 校验 schema —— 每字段：名字 / 单位 / 取值范围。
 * 缺字段、类型错、超范围会在 import 本文件时直接抛错（启动即失败）。
 */
export const envSchema = z.object({
  /** 数据库连接串（必填，postgres:// 起头） */
  DATABASE_URL: z
    .string({ required_error: 'DATABASE_URL 必填' })
    .min(1, 'DATABASE_URL 必填')
    .startsWith('postgres://', 'DATABASE_URL 必须以 postgres:// 起头'),
  /** 端口，单位：无，范围 1–65535 */
  PORT: z.coerce
    .number()
    .int('PORT 必须是整数')
    .min(1, 'PORT 最小 1')
    .max(65535, 'PORT 最大 65535')
    .default(3000),
  /** 运行环境 */
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** 时区 */
  TZ: z.string().min(1, 'TZ 必填').default('Asia/Shanghai'),
  /** 赛季天数，单位：游戏日，范围 >= 1 */
  SEASON_DAYS: z.coerce
    .number()
    .int('SEASON_DAYS 必须是整数')
    .positive('SEASON_DAYS 必须是正整数')
    .default(DEFAULT_SEASON_DAYS),
  /** AI 接口 key（可空 = 模板兜底，不花钱） */
  AI_API_KEY: z.string().default(''),
  /** AI 模型名（可空） */
  AI_MODEL: z.string().default(''),
  /** 是否自动发布 AI 事件，只接受 true/false */
  AI_AUTO_PUBLISH: z.enum(['true', 'false']).default('false'),
  /** 管理账号 */
  ADMIN_USER: z.string().min(1, 'ADMIN_USER 必填').default('admin'),
  /** 管理密码（可空） */
  ADMIN_PASS: z.string().default(''),
});

const env = envSchema.parse(process.env);

export const config = {
  databaseUrl: env.DATABASE_URL,
  port: env.PORT,
  nodeEnv: env.NODE_ENV,
  tz: env.TZ,
  /** 赛季天数：一现实日一游戏日，第 10 日结算后赛季结束（#1 正文 / #2 结论） */
  seasonDays: env.SEASON_DAYS,
  ai: {
    apiKey: env.AI_API_KEY,
    model: env.AI_MODEL,
    autoPublish: env.AI_AUTO_PUBLISH === 'true',
  },
  admin: {
    user: env.ADMIN_USER,
    pass: env.ADMIN_PASS,
  },
};

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
export const STARTING_SILVER = 500;
export const STARTING_REPUTATION = 50;
export const STARTING_HAPPINESS = 60;
export const CITY_COUNT = 20;

/** 建筑定义：产量随等级线性增长（M7 改为表驱动的上限/升级规则） */
export const BUILDINGS = {
  farm:       { label: '农田',   good: 'grain', outputPerLevel: 12, workersPerLevel: 2 },
  lumberyard: { label: '伐木场', good: 'wood',  outputPerLevel: 9,  workersPerLevel: 2 },
  quarry:     { label: '采石场', good: 'stone', outputPerLevel: 7,  workersPerLevel: 3 },
  mine:       { label: '铁矿',   good: 'iron',  outputPerLevel: 4,  workersPerLevel: 4 },
  workshop:   { label: '工坊',   good: 'cloth', outputPerLevel: 6,  workersPerLevel: 3 },
  market:     { label: '市集',   good: null,    outputPerLevel: 0,  workersPerLevel: 1 },
} as const;

export type BuildingKey = keyof typeof BUILDINGS;

/** 人均日耗（只列会被消耗的货物） */
export const CONSUMPTION_PER_CAPITA: Partial<Record<Good, number>> = {
  grain: 0.5,
  cloth: 0.05,
};

export const POPULATION = {
  growthRate: 0.03,
  /** 存粮 >= 这个倍数的日耗才增长（低于则持平） */
  growthFoodRatio: 2,
  starveRate: 0.05,
  starveHappiness: 10,
  happinessDrift: 1,
  happinessNeutral: 60,
} as const;

export const MARKET = {
  /** 价格弹性：供需差 / 供应量 的系数 */
  elasticity: 0.4,
  /** 人均日需求，用来算市场压力 */
  demandPerCapita: { grain: 0.5, wood: 0.15, stone: 0.1, iron: 0.03, cloth: 0.05 } as Record<
    Good,
    number
  >,
  basePrice: { grain: 10, wood: 12, stone: 14, iron: 30, cloth: 18 } as Record<Good, number>,
  minPrice: 1,
  maxPrice: 999,
  /** 单日涨跌幅上限（百分比） */
  maxDeltaPct: 25,
} as const;

/** 赛季末结算与破产判定用的常数（#1 / #4 第 4 节第 6、8 步） */
export const GAME = {
  /** 称雄：赛季末净资产第一且声望 >= 100（#1 胜负条件） */
  championReputation: 100,
  /** 破产：银 < 0 且 粮 < 0 连续 2 日 */
  bankruptDays: 2,
  /** 净资产里每点声望折多少银 */
  reputationValue: 10,
  /** 建筑估值：每级折价（银），用于赛季末净资产 */
  buildingValue: {
    farm: 300,
    lumberyard: 300,
    quarry: 300,
    mine: 400,
    workshop: 300,
    market: 150,
  } as Record<BuildingKey, number>,
} as const;

/** 结算用的 advisory lock 命名空间 */
export const SETTLE_LOCK_KEY = 'gmd:settle';
