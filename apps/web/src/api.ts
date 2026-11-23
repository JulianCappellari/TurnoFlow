export interface Clinic { id: string; name: string; timezone: string }
export interface Professional { id: string; name: string; specialty: string | null; serviceIds: string[] }
export interface Service { id: string; name: string; durationMin: number }
export interface Catalog { clinic: Clinic; professionals: Professional[]; services: Service[] }
export interface Slot { professionalId: string; startsAt: string; endsAt: string }
export interface AgendaItem {
  id: string; professionalId: string; serviceId: string; serviceName: string; patientId: string;
  patientName: string; patientPhone: string; startsAt: string; endsAt: string; status: string;
}
export interface Patient { id: string; fullName: string; phone: string }
export interface Hold { holdId: string; confirmationToken: string; expiresAt: string; startsAt: string; endsAt: string }

export type Mode = 'BOT' | 'HUMAN_PENDING' | 'HUMAN_ACTIVE' | 'CLOSED';
export interface Conversation {
  id: string; channel: string; mode: Mode; version: number; assignedTo: string | null; escalationReason: string | null;
  lastActivityAt: string; patientName: string | null; patientPhone: string | null; externalRef: string | null;
  lastMessage: { body: string; direction: string; senderKind: string } | null;
}
export interface Message { id: string; direction: 'IN' | 'OUT'; senderKind: string; body: string; deliveryStatus: string; createdAt: string }

const MESSAGES: Record<string, string> = {
  SLOT_TAKEN: 'Ese horario acaba de ser ocupado. Elegí otro.',
  SLOT_NOT_OFFERED: 'Ese horario ya no está disponible.',
  HOLD_EXPIRED: 'La reserva temporal venció. Volvé a elegir el horario.',
  HOLD_NOT_ACTIVE: 'La reserva temporal ya no está activa. Volvé a elegir el horario.',
  CONFLICT: 'La conversación cambió: otra persona la tomó o ya no está en ese estado. Actualizá la bandeja.',
  CANCELLATION_WINDOW_CLOSED: 'Ya pasó el plazo de cancelación.',
  FORBIDDEN: 'Tu rol no tiene permiso para esta acción.',
  UNAUTHENTICATED: 'Tu sesión venció. Ingresá de nuevo.',
  NOT_FOUND: 'No se encontró el recurso solicitado.',
  INVALID_TRANSITION: 'El turno ya no se puede modificar en su estado actual.',
};

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, detail: string) {
    super(MESSAGES[code] ?? detail);
  }
}

async function request<T>(token: string, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? 'GET', signal: init.signal,
      headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(0, 'NETWORK', 'No se pudo conectar con el servidor. Revisá tu conexión.');
  }
  if (!res.ok) {
    const p = (await res.json().catch(() => ({}))) as { title?: string; detail?: string };
    throw new ApiError(res.status, p.title ?? 'ERROR', p.detail ?? 'Ocurrió un error inesperado.');
  }
  return (await res.json()) as T;
}

const qs = (o: Record<string, string | undefined>) =>
  new URLSearchParams(Object.entries(o).filter((e): e is [string, string] => e[1] !== undefined)).toString();

export const api = (token: string) => ({
  clinics: () => request<{ clinics: Clinic[] }>(token, '/api/v1/clinics'),
  catalog: (clinicId: string) => request<Catalog>(token, `/api/v1/catalog?${qs({ clinicId })}`),
  agenda: (clinicId: string, from: Date, to: Date, signal?: AbortSignal) =>
    request<{ items: AgendaItem[] }>(token, `/api/v1/agenda?${qs({ clinicId, from: from.toISOString(), to: to.toISOString() })}`, { signal }),
  availability: (clinicId: string, serviceId: string, from: Date, to: Date, professionalId?: string, signal?: AbortSignal) =>
    request<{ slots: Slot[] }>(token, `/api/v1/availability?${qs({ clinicId, serviceId, from: from.toISOString(), to: to.toISOString(), professionalId })}`, { signal }),
  searchPatients: (q: string, signal?: AbortSignal) => request<{ patients: Patient[] }>(token, `/api/v1/patients?${qs({ q })}`, { signal }),
  createPatient: (fullName: string, phone: string) => request<Patient>(token, '/api/v1/patients', { method: 'POST', body: { fullName, phone } }),
  hold: (professionalId: string, serviceId: string, startsAt: string) =>
    request<Hold>(token, '/api/v1/booking-holds', { method: 'POST', body: { professionalId, serviceId, startsAt } }),
  confirm: (holdId: string, patientId: string, confirmationToken: string, idempotencyKey: string) =>
    request<{ appointmentId: string }>(token, '/api/v1/appointments/confirm', {
      method: 'POST', body: { holdId, patientId, confirmationToken }, headers: { 'idempotency-key': idempotencyKey },
    }),
  conversations: (mode?: Mode, signal?: AbortSignal) =>
    request<{ me: string; items: Conversation[] }>(token, `/api/v1/inbox/conversations?${qs({ mode })}`, { signal }),
  thread: (id: string, signal?: AbortSignal) =>
    request<{ me: string; conversation: Conversation; messages: Message[] }>(token, `/api/v1/inbox/conversations/${id}/messages`, { signal }),
  takeover: (id: string) => request<{ mode: Mode }>(token, `/api/v1/inbox/conversations/${id}/takeover`, { method: 'POST', body: {} }),
  release: (id: string) => request<{ mode: Mode }>(token, `/api/v1/inbox/conversations/${id}/release`, { method: 'POST', body: {} }),
  closeConversation: (id: string) => request<{ mode: Mode }>(token, `/api/v1/inbox/conversations/${id}/close`, { method: 'POST', body: {} }),
  reply: (id: string, body: string) => request<{ messageId: string }>(token, `/api/v1/inbox/conversations/${id}/messages`, { method: 'POST', body: { body } }),
  cancel: (id: string, reason?: string) =>
    request<{ alreadyCancelled: boolean }>(token, `/api/v1/appointments/${id}/cancel`, { method: 'POST', body: reason ? { reason } : {} }),
});
export type Api = ReturnType<typeof api>;

/** Display-only decode (the server is the authority). Never used for authorization decisions. */
export function peekRole(token: string): string | null {
  try {
    return (JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as { role?: string }).role ?? null;
  } catch { return null; }
}
