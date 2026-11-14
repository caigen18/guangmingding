/**
 * M8 用的一次性只读查询：把库里当前状态拼成事件载荷（city.updated / events.arrived）。
 * 只在事务提交后调用，保证推给客户端的是已落库状态。
 */
import { pool } from '../db/pool.js';
import type { CityUpdatedData, EventCard } from '../ws/events.js';

export interface ActiveSeason {
  id: number;
  currentDay: number;
}

/** 当前在跑的赛季（settling/ended 之外的第一个）；没有则 null。 */
export async function activeSeason(): Promise<ActiveSeason | null> {
  const { rows } = await pool.query(
    `SELECT id, current_day FROM seasons WHERE status = 'active' ORDER BY id DESC LIMIT 1`,
  );
  const row = (rows as Array<{ id: string; current_day: number }>)[0];
  return row ? { id: Number(row.id), currentDay: Number(row.current_day) } : null;
}

/** 全服城市快照（连接时推一遍，v1.1 字段）。 */
export async function listCitySnapshots(seasonId: number, day: number): Promise<CityUpdatedData[]> {
  const { rows } = await pool.query(
    `SELECT id, name, population::float8 AS population, happiness::float8 AS happiness,
            reputation::float8 AS reputation, resources, version
       FROM cities WHERE season_id = $1 ORDER BY name`,
    [seasonId],
  );
  return (rows as Array<Record<string, unknown>>).map((r) =>
    cityUpdatedFromRow(r, seasonId, day),
  );
}

export function cityUpdatedFromRow(
  r: Record<string, unknown>,
  seasonId: number,
  day: number,
): CityUpdatedData {
  return {
    season_id: seasonId,
    day,
    city_id: String(r.id),
    name: String(r.name),
    population: Number(r.population),
    happiness: Number(r.happiness),
    reputation: Number(r.reputation),
    resources: (r.resources ?? {}) as Record<string, number>,
    version: Number(r.version),
  };
}

/** 某城当天还没处理的事件卡；没有就是空数组（空日也发 events.arrived）。 */
export async function pendingCards(
  seasonId: number,
  day: number,
  cityId: string,
): Promise<EventCard[]> {
  const { rows } = await pool.query(
    `SELECT e.id, e.template_key, e.title, e.body, e.severity, e.choices, e.generated_by,
            e.created_day, ce.expires_day
       FROM city_events ce
       JOIN events e ON e.id = ce.event_id
      WHERE ce.city_id = $1 AND ce.status = 'pending' AND e.season_id = $2 AND ce.expires_day >= $3
      ORDER BY ce.created_at`,
    [cityId, seasonId, day],
  );
  return (rows as Array<Record<string, unknown>>).map((r) => ({
    event_id: String(r.id),
    title: String(r.title),
    body: String(r.body ?? ''),
    severity: String(r.severity) as EventCard['severity'],
    choices: (r.choices ?? []) as EventCard['choices'],
    generated_by: String(r.generated_by) as EventCard['generated_by'],
    created_day: Number(r.created_day),
    expires_day: Number(r.expires_day),
    status: 'pending' as const,
  }));
}
