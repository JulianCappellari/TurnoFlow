import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { DomainError } from '@turnoflow/domain';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

export type Queryable = Pick<Pool | PoolClient, 'query'>;

export async function withTx<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

export async function rows<T extends QueryResultRow>(q: Queryable, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await q.query<T>(sql, params)).rows;
}

export async function one<T extends QueryResultRow>(q: Queryable, sql: string, params: unknown[] = []): Promise<T | undefined> {
  return (await rows<T>(q, sql, params))[0];
}

/** Serializes writers of one professional's agenda inside the current transaction (RN-010). */
export async function lockProfessionalAgenda(c: Queryable, tenantId: string, professionalId: string): Promise<void> {
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`agenda:${tenantId}:${professionalId}`]);
}

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
export const newToken = (): string => randomBytes(32).toString('base64url');

export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Stable JSON (sorted keys) so request hashes do not depend on property order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

interface PgError { code?: string; constraint?: string }
export const pgCode = (e: unknown): string | undefined => (e as PgError | null)?.code;

/** Maps database-level race outcomes to domain errors (the constraints are the last line of defence). */
export function mapSlotConflict(e: unknown): never {
  const code = pgCode(e);
  if (code === '23P01' || code === '23505') throw new DomainError('SLOT_TAKEN', 'The slot is no longer available');
  throw e;
}

export const isUuid = (s: unknown): s is string =>
  typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
