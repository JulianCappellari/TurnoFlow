import { Pool } from 'pg';
import { migrate } from './migrate.ts';

const url = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL;
if (!url) throw new Error('Set DATABASE_URL');
const pool = new Pool({ connectionString: url });
try {
  const applied = await migrate(pool);
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date');
} finally {
  await pool.end();
}
