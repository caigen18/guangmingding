/**
 * M7（issue #17）zod 生效自检：验证 config/game.ts 的 envSchema
 * 对「缺字段 / 写错类型 / 超范围」三类输入启动即报错，且合法配置能通过。
 * 无 DB 依赖。CI 里跑 `node dist/game/m7-check.js`，本地 `node --import tsx src/game/m7-check.ts`。
 */
import { envSchema } from '../config/game.js';

let failed = 0;

function expectError(name: string, input: Record<string, unknown>): void {
  const result = envSchema.safeParse(input);
  if (result.success) {
    console.error(`[FAIL] ${name}: 应该报错却没有（通过值=${JSON.stringify(result.data)}）`);
    failed += 1;
    return;
  }
  console.log(`[PASS] ${name}: 启动即报错`);
  for (const issue of result.error.issues) {
    const path = issue.path.join('.') || '(root)';
    console.log(`       - ${path}: ${issue.message}`);
  }
}

console.log('== M7 zod 校验自检 ==');

// 1. 缺字段：DATABASE_URL 没给（无默认值兜底）
expectError('缺字段（DATABASE_URL 缺失）', {});

// 2. 写错类型：PORT 传非数字
expectError('写错类型（PORT=abc）', {
  DATABASE_URL: 'postgres://gmd:gmd@127.0.0.1:5432/gmd',
  PORT: 'abc',
});

// 3. 超范围：SEASON_DAYS=0（非正）
expectError('超范围（SEASON_DAYS=0）', {
  DATABASE_URL: 'postgres://gmd:gmd@127.0.0.1:5432/gmd',
  SEASON_DAYS: '0',
});

// 3b. 超范围：PORT=99999
expectError('超范围（PORT=99999）', {
  DATABASE_URL: 'postgres://gmd:gmd@127.0.0.1:5432/gmd',
  PORT: '99999',
});

// 合法配置应通过
const ok = envSchema.safeParse({
  DATABASE_URL: 'postgres://gmd:gmd@127.0.0.1:5432/gmd',
  PORT: '3000',
  NODE_ENV: 'development',
  SEASON_DAYS: '10',
});
if (!ok.success) {
  console.error(`[FAIL] 合法配置被拒: ${JSON.stringify(ok.error.issues)}`);
  failed += 1;
} else {
  console.log(
    `[PASS] 合法配置通过: port=${ok.data.PORT} seasonDays=${ok.data.SEASON_DAYS} autoPublish=${ok.data.AI_AUTO_PUBLISH}`,
  );
}

if (failed > 0) {
  console.error(`\n共 ${failed} 项失败`);
  process.exit(1);
}
console.log('\n全部通过');
