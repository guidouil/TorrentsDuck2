import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

describe.skipIf(!process.env.TEST_DATABASE_URL)('bandwidth peak schema with PostgreSQL', () => {
  const schema = `bandwidth_test_${randomUUID().replaceAll('-', '')}`;
  let db: Client;
  let migration: string;
  let connected = false;

  beforeAll(async () => {
    db = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await db.connect();
    connected = true;
    await db.query(`CREATE SCHEMA "${schema}"`);
    await db.query(`SET search_path TO "${schema}"`);
    migration = await readFile(new URL('../db/001-initial.sql', import.meta.url), 'utf8');
    await db.query(migration);
  });

  afterAll(async () => {
    if (!connected) return;
    try {
      await db.query('ROLLBACK');
      await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await db.end();
    }
  });

  it('initializes one row and preserves both peaks when the migration is replayed', async () => {
    expect((await db.query('SELECT download,upload FROM bandwidth_peaks')).rows).toEqual([{ download: '0', upload: '0' }]);
    await db.query('UPDATE bandwidth_peaks SET download=50000000,upload=10000000');
    await db.query(migration);
    expect((await db.query('SELECT download,upload FROM bandwidth_peaks')).rows).toEqual([{ download: '50000000', upload: '10000000' }]);
  });

  it('rejects another row and a false singleton key', async () => {
    await expect(db.query('INSERT INTO bandwidth_peaks DEFAULT VALUES')).rejects.toMatchObject({ code: '23505' });
    await expect(db.query('INSERT INTO bandwidth_peaks(id) VALUES(false)')).rejects.toMatchObject({ code: '23514' });
    expect((await db.query('SELECT count(*)::int AS count FROM bandwidth_peaks')).rows).toEqual([{ count: 1 }]);
  });

  it.each(['download', 'upload'])('rejects a negative %s peak', async (column) => {
    await expect(db.query(`UPDATE bandwidth_peaks SET ${column}=-1`)).rejects.toMatchObject({ code: '23514' });
  });
});
