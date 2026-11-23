// Development seed: ONE demo tenant with SYNTHETIC data and a short-lived receptionist token.
// Usage: DATABASE_URL=... AUTH_SECRET=... node --experimental-strip-types apps/api/src/dev/seed.ts [role]
import { Pool } from 'pg';
import { InboxService, migrate } from '@turnoflow/db';
import { ROLES, signSessionToken, type Role } from '../auth.ts';

if (process.env.NODE_ENV === 'production') throw new Error('Refusing to seed in production');
const url = process.env.DATABASE_URL;
const secret = process.env.AUTH_SECRET;
if (!url || !secret) throw new Error('DATABASE_URL and AUTH_SECRET are required');
const role = (process.argv[2] ?? 'receptionist') as Role;
if (!ROLES.includes(role)) throw new Error(`Unknown role. Use one of: ${ROLES.join(', ')}`);

const pool = new Pool({ connectionString: url, max: 2 });
try {
  await migrate(pool);
  let t = (await pool.query<{ id: string }>(`SELECT id FROM tenants WHERE slug = 'demo-clinica'`)).rows[0];
  if (!t) {
    t = (await pool.query<{ id: string }>(`INSERT INTO tenants (slug, name, status) VALUES ('demo-clinica', 'Demo Clínica Odontológica', 'ACTIVE') RETURNING id`)).rows[0]!;
    const tid = t.id;
    const clinic = (await pool.query<{ id: string }>(
      `INSERT INTO clinics (tenant_id, name, timezone, slot_step_min) VALUES ($1, 'Sede Centro', 'America/Argentina/Buenos_Aires', 15) RETURNING id`, [tid])).rows[0]!.id;
    const prof = async (name: string, specialty: string) =>
      (await pool.query<{ id: string }>('INSERT INTO professionals (tenant_id, clinic_id, name, specialty) VALUES ($1,$2,$3,$4) RETURNING id', [tid, clinic, name, specialty])).rows[0]!.id;
    const svc = async (name: string, dur: number, buf: number) =>
      (await pool.query<{ id: string }>('INSERT INTO services (tenant_id, name, duration_min, buffer_min) VALUES ($1,$2,$3,$4) RETURNING id', [tid, name, dur, buf])).rows[0]!.id;
    const drA = await prof('Dra. Lucía Fernández', 'Odontología general');
    const drB = await prof('Dr. Martín Acosta', 'Ortodoncia');
    const consulta = await svc('Consulta', 30, 0);
    const limpieza = await svc('Limpieza dental', 45, 15);
    const control = await svc('Control de ortodoncia', 30, 0);
    const link = (p: string, s: string) => pool.query('INSERT INTO professional_services (tenant_id, professional_id, service_id) VALUES ($1,$2,$3)', [tid, p, s]);
    await Promise.all([link(drA, consulta), link(drA, limpieza), link(drB, consulta), link(drB, control)]);
    for (let d = 1; d <= 5; d++) {
      await pool.query('INSERT INTO schedules (tenant_id, professional_id, weekday, start_minute, end_minute) VALUES ($1,$2,$3,540,780),($1,$2,$3,840,1080)', [tid, drA, d]);
      await pool.query('INSERT INTO schedules (tenant_id, professional_id, weekday, start_minute, end_minute) VALUES ($1,$2,$3,600,840)', [tid, drB, d]);
    }
    const people: [string, string][] = [['Valentina Rossi', '+5491155550101'], ['Joaquín Medina', '+5491155550102'], ['Camila Ortiz', '+5491155550103']];
    for (const [n, p] of people) await pool.query('INSERT INTO patients (tenant_id, full_name, phone_e164) VALUES ($1,$2,$3)', [tid, n, p]);
    console.log('Seeded demo tenant (synthetic data).');
  } else {
    console.log('Demo tenant already exists.');
  }
  await pool.query('UPDATE clinics SET agent_enabled = true WHERE tenant_id = $1', [t.id]); // demo only: the flag is OFF by default
  await pool.query(
    `INSERT INTO channel_accounts (tenant_id, clinic_id, provider, external_account_ref)
     SELECT $1, id, 'whatsapp', 'demo-phone-1' FROM clinics WHERE tenant_id = $1 ORDER BY created_at LIMIT 1
     ON CONFLICT (provider, external_account_ref) DO NOTHING`, [t.id]);
  // Synthetic conversations so the inbox has something to show (only if the tenant has none yet).
  const hasConv = (await pool.query('SELECT 1 FROM conversations WHERE tenant_id = $1 LIMIT 1', [t.id])).rowCount;
  if (!hasConv) {
    const clinicId = (await pool.query<{ id: string }>('SELECT id FROM clinics WHERE tenant_id = $1 LIMIT 1', [t.id])).rows[0]!.id;
    const patient = async (name: string) => (await pool.query<{ id: string }>('SELECT id FROM patients WHERE tenant_id = $1 AND full_name = $2', [t.id, name])).rows[0]?.id;
    const box = new InboxService(pool);
    const sys = { tenantId: t.id, actor: { type: 'system' as const } };
    const open = async (ref: string, patientId: string | undefined, lines: [boolean, string][]) => {
      const { id } = await box.openConversation(sys, { clinicId, channel: 'WHATSAPP', externalRef: ref, patientId });
      let v = 1;
      for (const [fromPatient, body] of lines) {
        if (fromPatient) v = (await box.recordInbound(sys, { conversationId: id, body })).version;
        else await box.recordBotMessage(sys, { conversationId: id, expectedVersion: v, body });
      }
      return id;
    };
    await open('demo-wa-1', await patient('Valentina Rossi'), [
      [true, 'Hola! Quiero reservar una limpieza para la semana que viene'],
      [false, 'Hola Valentina, con gusto. ¿Preferís mañana o tarde?'],
      [true, 'Por la tarde, si puede ser el miércoles']]);
    const pending = await open('demo-wa-2', await patient('Joaquín Medina'), [
      [true, 'Buenas, me duele mucho una muela desde anoche'],
      [false, 'Lamento que estés con dolor. Voy a avisar a recepción para que te atiendan lo antes posible.']]);
    await box.requestHuman(sys, { conversationId: pending, reason: 'Posible urgencia: derivado a recepción' });
    await open('demo-wa-3', undefined, [[true, 'Hola, ¿atienden con obra social?']]);
    console.log('Seeded 3 synthetic conversations.');
  }

  const ttl = 8 * 3600;
  console.log(`\nRole: ${role}  |  token valid ${ttl / 3600} h  |  paste into the panel login:\n`);
  console.log(signSessionToken(secret, { userId: 'demo-user', tenantId: t.id, role }, ttl));
} finally {
  await pool.end();
}
