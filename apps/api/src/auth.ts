import { createHmac, timingSafeEqual } from 'node:crypto';

export const ROLES = ['owner', 'admin_clinic', 'receptionist', 'practitioner', 'support_limited'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = ['schedule.read', 'appointment.create', 'appointment.cancel', 'appointment.read', 'patient.read', 'patient.write', 'inbox.read', 'inbox.takeover'] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** RF-004: deny by default. A role only has what is listed here. */
const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: ['schedule.read', 'appointment.create', 'appointment.cancel', 'appointment.read', 'patient.read', 'patient.write', 'inbox.read', 'inbox.takeover'],
  admin_clinic: ['schedule.read', 'appointment.create', 'appointment.cancel', 'appointment.read', 'patient.read', 'patient.write', 'inbox.read', 'inbox.takeover'],
  receptionist: ['schedule.read', 'appointment.create', 'appointment.cancel', 'appointment.read', 'patient.read', 'patient.write', 'inbox.read', 'inbox.takeover'],
  practitioner: ['schedule.read'],
  support_limited: [], // no access to appointment data by default (US-003)
};

export const can = (role: Role, permission: Permission): boolean => ROLE_PERMISSIONS[role].includes(permission);

export interface Session { userId: string; tenantId: string; role: Role }

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/**
 * INTERIM session token (HS256). The spec calls for a managed identity provider with MFA (RF-005);
 * this keeps the API contract (tenant and role come from a verified credential, never from the body)
 * until that provider is chosen. Replace `verifySessionToken` behind the same `Session` shape.
 */
export function signSessionToken(secret: string, s: Session, ttlSec = 900, nowSec = Math.floor(Date.now() / 1000)): string {
  const head = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64(JSON.stringify({ sub: s.userId, tid: s.tenantId, role: s.role, exp: nowSec + ttlSec }));
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

export function verifySessionToken(secret: string, token: string, nowSec = Math.floor(Date.now() / 1000)): Session | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts as [string, string, string];
  const expected = createHmac('sha256', secret).update(`${head}.${body}`).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    if ((JSON.parse(Buffer.from(head, 'base64url').toString()) as { alg?: string }).alg !== 'HS256') return null;
    const p = JSON.parse(Buffer.from(body, 'base64url').toString()) as { sub?: unknown; tid?: unknown; role?: unknown; exp?: unknown };
    if (typeof p.exp !== 'number' || p.exp <= nowSec) return null;
    if (typeof p.sub !== 'string' || typeof p.tid !== 'string') return null;
    if (!ROLES.includes(p.role as Role)) return null;
    return { userId: p.sub, tenantId: p.tid, role: p.role as Role };
  } catch {
    return null;
  }
}
