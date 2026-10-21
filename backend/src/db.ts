import pg, { type PoolClient } from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// DATE must remain a calendar date, independent of the client's time zone.
pg.types.setTypeParser(1082, value => value);
export const pool = new pg.Pool({ max: 12, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 });
pool.on('error', () => console.error('Database idle connection error'));
export async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const result = await fn(c); await c.query('COMMIT'); return result; }
  catch (e) { await c.query('ROLLBACK'); throw e; }
  finally { c.release(); }
}
export async function migrate() {
  await transaction(async c => {
    await c.query('SELECT pg_advisory_xact_lock(7120261021)');
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    for (const name of (await readdir('database/migrations')).filter(n => n.endsWith('.sql')).sort()) {
      const sql = await readFile(`database/migrations/${name}`, 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const old = await c.query('SELECT checksum FROM schema_migrations WHERE name=$1', [name]);
      if (old.rowCount) { if (old.rows[0].checksum !== checksum) throw new Error(`Migration changed: ${name}`); continue; }
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations(name,checksum) VALUES ($1,$2)', [name, checksum]);
    }
  });
}
export async function seed() {
  if (process.env.SEED_DEMO_DATA !== 'true') return;
  await transaction(async c => {
    await c.query('SELECT pg_advisory_xact_lock(7120261021)');
    await c.query('CREATE TABLE IF NOT EXISTS seed_runs (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    if ((await c.query("SELECT 1 FROM seed_runs WHERE name='demo-v1'")).rowCount) return;
    await c.query(await readFile('database/seed.sql', 'utf8'));
    await c.query("INSERT INTO seed_runs(name) VALUES ('demo-v1')");
  });
}
