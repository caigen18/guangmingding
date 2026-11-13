/**
 * season.ts —— 赛季末结算（#4 第 4 节第 8 步）：settling → 净资产排名 → 三档结局 → ended。
 * 世界重置在 season-reset.ts；称号追加到 players.titles，跨赛季保留。
 */
import type { PoolClient } from 'pg';
import { GAME } from '../config/game.js';
import { resetSeason } from './season-reset.js';

export type SeasonRankInput = {
  cityId: string;
  city: string;
  player: string | null;
  playerId: string | null;
  population: number;
  happiness: number;
  silver: number;
  grain: number;
  reputation: number;
  buildingValue: number;
  bankrupt: boolean;
  bankruptReason: string | null;
};

export type Ending = '称雄' | '存活' | '出局';

export type SeasonRank = SeasonRankInput & { rank: number; netWorth: number; ending: Ending };

export type SeasonSummary = {
  seasonNo: number;
  seasonDays: number;
  endedAt: string;
  grainPrice: number;
  champion: SeasonRank | null;
  rankings: SeasonRank[];
  nextSeason: { id: string; seasonNo: number } | null;
};

/** 净资产 = 银 + 粮 × 当日粮价 + 建筑估值 + 声望 × 权重（#1 胜负条件） */
export function netWorthOf(
  r: Pick<SeasonRankInput, 'silver' | 'grain' | 'reputation' | 'buildingValue'>,
  grainPrice: number,
): number {
  const raw = r.silver + r.grain * grainPrice + r.buildingValue + r.reputation * GAME.reputationValue;
  return Math.round(raw * 100) / 100;
}

export type CloseSeasonInput = {
  seasonId: string;
  seasonNo: number;
  seasonDays: number;
  grainPrice: number;
  ranks: SeasonRankInput[];
  resetWorld: boolean;
};

/** 第 8 步：settling → 排名/三档结局 → 称号写入 players.titles → ended（→ 可选世界重置） */
export async function closeSeason(
  client: PoolClient,
  input: CloseSeasonInput,
): Promise<SeasonSummary> {
  await client.query(`UPDATE seasons SET status = 'settling' WHERE id = $1`, [input.seasonId]);

  const rankings: SeasonRank[] = input.ranks
    .map((r) => ({
      ...r,
      netWorth: netWorthOf(r, input.grainPrice),
      rank: 0,
      ending: '存活' as Ending,
    }))
    .sort((a, b) => b.netWorth - a.netWorth)
    .map((r, i) => ({
      ...r,
      rank: i + 1,
      ending: (r.bankrupt
        ? '出局'
        : i === 0 && r.reputation >= GAME.championReputation
          ? '称雄'
          : '存活') as Ending,
    }));

  for (const r of rankings) {
    if (!r.player) continue;
    const title = r.ending === '称雄' ? '称雄' : r.rank <= 3 ? '一方霸主' : '偏安一隅';
    await client.query(`UPDATE players SET titles = titles || $2::jsonb WHERE name = $1`, [
      r.player,
      JSON.stringify([
        { season: input.seasonNo, ending: r.ending, rank: r.rank, title, city: r.city },
      ]),
    ]);
  }

  await client.query(`UPDATE seasons SET status = 'ended', ends_at = now() WHERE id = $1`, [
    input.seasonId,
  ]);

  const nextSeason = input.resetWorld
    ? await resetSeason(client, input.seasonId, input.seasonNo)
    : null;

  return {
    seasonNo: input.seasonNo,
    seasonDays: input.seasonDays,
    endedAt: new Date().toISOString(),
    grainPrice: input.grainPrice,
    champion: rankings[0] ?? null,
    rankings,
    nextSeason,
  };
}
