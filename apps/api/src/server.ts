import { Pool } from 'pg';
import { buildApp } from './app.ts';

const databaseUrl = process.env.DATABASE_URL;
const authSecret = process.env.AUTH_SECRET;
if (!databaseUrl || !authSecret) throw new Error('DATABASE_URL and AUTH_SECRET are required');

const pool = new Pool({ connectionString: databaseUrl, max: Number(process.env.DB_POOL_MAX ?? 20) });
const waSecret = process.env.WHATSAPP_APP_SECRET;
const waVerify = process.env.WHATSAPP_VERIFY_TOKEN;
const app = buildApp({ pool, authSecret, logger: true, whatsapp: waSecret && waVerify ? { appSecret: waSecret, verifyToken: waVerify } : undefined });
await app.listen({ port: Number(process.env.PORT ?? 3000), host: process.env.HOST ?? '127.0.0.1' });
const shutdown = async () => { await app.close(); await pool.end(); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
