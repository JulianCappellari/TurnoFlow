import { DateTime } from 'luxon';
import { isAffirmative, normalize } from './guards.ts';
import type { LlmGateway, LlmMessage, LlmRequest, LlmTurn } from './types.ts';

/**
 * A rule-based STAND-IN for a language model, for local development and for exercising the orchestrator end to end.
 * It is intentionally small and is not a language-understanding component: no real model is connected (D-05/D-13/legal pending).
 * It only decides which tool to propose; all safety lives in the orchestrator.
 */
export class RuleBasedMockLlm implements LlmGateway {
  async complete(req: LlmRequest): Promise<LlmTurn> {
    const lastUser = lastIndex(req.messages, (m) => m.role === 'user');
    const userText = lastUser >= 0 ? stripWrapper((req.messages[lastUser] as { text: string }).text) : '';
    const tools = req.messages.slice(lastUser + 1).filter((m): m is Extract<LlmMessage, { role: 'tool' }> => m.role === 'tool');
    const lastTool = tools.at(-1);
    const c = req.context;

    if (lastTool) {
      const r = lastTool.result as { ok?: boolean; error?: string; available?: boolean; text?: string; offers?: unknown[] };
      if (lastTool.name === 'getApprovedPolicy') {
        return r.ok && r.available ? text(r.text ?? '') : call('handoffToHuman', { reason: 'Consulta sin información aprobada' });
      }
      if (lastTool.name === 'searchAvailability') {
        if (r.ok && Array.isArray(r.offers) && r.offers.length === 0) return text('No encontré horarios libres en esas fechas. ¿Querés que busque en otra semana?');
        if (r.error === 'UNKNOWN_SERVICE' || r.error === 'AMBIGUOUS_SERVICE') return text(`¿Para qué práctica querés el turno? Tenemos: ${c.services.join(', ')}.`);
        return call('handoffToHuman', { reason: 'No pude buscar disponibilidad' });
      }
      if (lastTool.name === 'createHold') return text('Ese horario ya no está disponible. ¿Busco otras opciones?');
      if (lastTool.name === 'confirmAppointment') return text('Para confirmar necesito que me respondas SÍ.');
      return call('handoffToHuman', { reason: 'Consulta fuera del alcance del asistente' });
    }

    const t = normalize(userText);
    if (c.pending && isAffirmative(userText)) return call('confirmAppointment', {});
    const pick = /^(el |la |opcion |numero )?([1-6])\b/.exec(t);
    if (pick && c.offers.length > 0) return call('createHold', { slotRef: `s${pick[2]}` });
    if (/\b(horario|horarios|atienden|abren|cierran|hora de atencion)\b/.test(t)) return call('getApprovedPolicy', { topic: 'horarios' });
    if (/\b(practicas|servicios|tratamientos|que hacen)\b/.test(t)) return call('getApprovedPolicy', { topic: 'practicas' });
    if (/\b(turno|reservar|reserva|agendar|agenda|cita|consulta|limpieza|control|ortodoncia)\b/.test(t)) {
      const service = c.services.find((s) => t.includes(normalize(s).split(' ')[0]!)) ?? c.services.find((s) => normalize(s) === 'consulta');
      if (!service || !/\b(consulta|limpieza|control|ortodoncia)\b/.test(t) && c.services.length > 1 && !c.services.some((s) => t.includes(normalize(s)))) {
        return text(`¿Para qué práctica querés el turno? Tenemos: ${c.services.join(', ')}.`);
      }
      const { from, to } = dates(t, c.today);
      return call('searchAvailability', { service, dateFrom: from, dateTo: to });
    }
    if (/^(hola|buen dia|buenas|buenos dias|buenas tardes|buenas noches)\b/.test(t)) {
      return text(`Hola, soy el asistente virtual de ${c.clinicName}. Puedo ayudarte a reservar un turno o contarte horarios y prácticas. ¿Qué necesitás?`);
    }
    return call('handoffToHuman', { reason: 'Consulta fuera del alcance del asistente' });
  }
}

const text = (t: string): LlmTurn => ({ type: 'text', text: t });
const call = (name: string, args: unknown): LlmTurn => ({ type: 'tool_call', name, args });
const stripWrapper = (s: string) => s.replace(/<\/?mensaje_paciente>/g, '');
function lastIndex<T>(xs: T[], f: (x: T) => boolean): number { for (let i = xs.length - 1; i >= 0; i--) if (f(xs[i]!)) return i; return -1; }

const WEEKDAYS: Record<string, number> = { lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6, domingo: 7 };
function dates(t: string, today: string): { from: string; to: string } {
  const base = DateTime.fromISO(today);
  if (/\bhoy\b/.test(t)) return { from: today, to: today };
  if (/\bmanana\b/.test(t)) { const d = base.plus({ days: 1 }).toISODate()!; return { from: d, to: d }; }
  for (const [name, n] of Object.entries(WEEKDAYS)) {
    if (t.includes(name)) { const d = base.plus({ days: ((n - base.weekday + 7) % 7) || 7 }).toISODate()!; return { from: d, to: d }; }
  }
  return { from: base.plus({ days: 1 }).toISODate()!, to: base.plus({ days: 7 }).toISODate()! };
}
