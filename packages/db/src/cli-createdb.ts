// Creates the database named in DATABASE_URL if it does not exist (development convenience). Never drops anything.
import { Pool } from 'pg';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('Set DATABASE_URL, e.g. postgres://postgres:postgres@localhost:54329/turnoflow_dev');
const target = new URL(url);
const name = target.pathname.slice(1);
if (!/^[a-z0-9_]+$/.test(name)) throw new Error('Database name must match [a-z0-9_]+');
target.pathname = '/postgres';
const admin = new Pool({ connectionString: target.toString(), max: 1 });
try {
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
  if (exists.rowCount) console.log(`Database ${name} already exists`);
  else { await admin.query(`CREATE DATABASE ${name}`); console.log(`Created database ${name}`); }
} finally { await admin.end(); }
