import { readFile } from 'node:fs/promises';
import { db } from '../src/lib/server/db';

try {
  await db.query(await readFile(new URL('../db/001-initial.sql', import.meta.url), 'utf8'));
  console.log('Database schema ready. Existing data preserved.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Database initialization failed');
  process.exitCode = 1;
} finally {
  await db.end();
}
