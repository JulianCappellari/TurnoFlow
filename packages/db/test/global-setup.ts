import { Pool } from 'pg';
import { migrate } from '../src/migrate.ts';

export const TEST_DB_NAME = 'turnoflow_test';
export const baseUrl = (): string =>
  process.env.TEST_DATABASE_URL ?? `postgres://postgres:postgres@localhost:54329/${TEST_DB_NAME}`;

/** Recreates the test database from scratch and applies all migrations (real PostgreSQL, spec 17.1). */
export default async function setup(): Promise<void> {
  const url = new URL(baseUrl());
  const dbName = url.pathname.slice(1);
  if (!/^[a-z0-9_]+$/.test(dbName) || !dbName.includes('test')) {
    throw new Error(`Refusing to reset database "${dbName}": name must contain "test"`);
  }
  url.pathname = '/postgres';
  const admin = new Pool({ connectionString: url.toString(), max: 1 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${dbName}`);
  } finally {
    await admin.end();
  }
  const pool = new Pool({ connectionString: baseUrl(), max: 1 });
  try {
    await migrate(pool);
  } finally {
    await pool.end();
  }
}
