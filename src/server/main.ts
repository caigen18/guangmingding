import { buildApp } from './app.js';
import { config } from '../config/game.js';

async function main(): Promise<void> {
  const app = await buildApp();
  try {
    await app.listen({ port: config.port, host: '0.0.0.0' });
    app.log.info(`listening on :${config.port} (${config.nodeEnv}, TZ=${config.tz})`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    process.exit(0);
  });
}

main();
