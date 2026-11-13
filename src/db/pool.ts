import pg from 'pg';
import { config } from '../config/game.js';

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
});

export type Db = pg.Pool | pg.PoolClient;
