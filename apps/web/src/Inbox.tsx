import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, type Api, type Conversation, type Message, type Mode } from './api.ts';
import { Alert } from './ui.tsx';
import { formatTime } from './time.ts';

const POLL_MS = 8000;

type Filter = 'OPEN' | 'HUMAN_PENDING' | 'HUMAN_ACTIVE' | 'BOT' | 'CLOSED';
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'OPEN', label: 'Abiertas' }, { id: 'HUMAN_PENDING', label: 'Esperan persona' },
  { id: 'HUMAN_ACTIVE', label: 'Con una persona' }, { id: 'BOT', label: 'Asistente' }, { id: 'CLOSED', label: 'Cerradas' },
];
const DELIVERY: Record<string, string> = {
  PENDING: 'pendiente de envío', SENT: 'enviado', DELIVERED: 'entregado', READ: 'leído',
  FAILED: 'no se pudo enviar', SUPPRESSED: 'no enviado: cambió quién atiende',
};
const SENDER: Record<string, string> = { PATIENT: 'Paciente', BOT: 'Asistente', HUMAN: 'Recepción', SYSTEM: 'Sistema' };

export function modeLabel(c: Pick<Conversation, 'mode' | 'assignedTo'>, me: string): string {
  switch (c.mode as Mode) {
    case 'BOT': return 'Responde el asistente';
    case 'HUMAN_PENDING': return 'Espera a una persona';
    case 'HUMAN_ACTIVE': return c.assignedTo === me ? 'La atendés vos' : `La atiende ${c.assignedTo?.replace(/^user:/, '') ?? 'otra persona'}`;
    default: return 'Cerrada';
  }
}

interface Props { client: Api; tz: string; canAct: boolean; isAdmin: boolean; onUnauthorized: () => void; onPendingCount: (n: number) => void }

export function Inbox({ client, tz, canAct, isAdmin, onUnauthorized, onPendingCount }: Props) {
  const [filter, setFilter] = useState<Filter>('OPEN');
  const [items, setItems] = useState<Conversation[] | null>(null);
  const [me, setMe] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState('');

  const fail = useCallback((e: unknown) => {
    if ((e as Error).name === 'AbortError') return;
    if (e instanceof ApiError && e.status === 401) return onUnauthorized();
    setError((e as Error).message);
  }, [onUnauthorized]);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const r = await client.conversations(filter === 'OPEN' ? undefined : filter, signal);
      setItems(r.items); setMe(r.me); setError('');
      if (filter === 'OPEN') onPendingCount(r.items.filter((c) => c.mode === 'HUMAN_PENDING').length);
    } catch (e) { fail(e); }
  }, [client, filter, fail, onPendingCount]);

  useEffect(() => {
    setItems(null);
    const ctl = new AbortController();
    void load(ctl.signal);
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, POLL_MS);
    return () => { ctl.abort(); clearInterval(timer); };
  }, [load]);

  return (
    <div className={`inbox${selected ? ' has-selection' : ''}`}>
      <section className="inbox-list" aria-label="Conversaciones">
        <div className="filters" role="group" aria-label="Filtrar conversaciones">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" className={`pill${filter === f.id ? ' on' : ''}`} aria-pressed={filter === f.id} onClick={() => { setFilter(f.id); setSelected(null); }}>
              {f.label}
            </button>
          ))}
        </div>
        {error && <Alert>{error}</Alert>}
        {!items && !error && <p role="status" className="muted pad">Cargando conversaciones…</p>}
        {items && items.length === 0 && <p className="empty">No hay conversaciones en esta vista.</p>}
        <ul className="conv-list">
          {sortPending(items ?? []).map((c) => (
            <li key={c.id}>
              <button type="button" className={`conv${selected === c.id ? ' on' : ''}${c.mode === 'HUMAN_PENDING' ? ' pending' : ''}`} onClick={() => setSelected(c.id)} aria-current={selected === c.id}>
                <span className="conv-top">
                  <strong>{c.patientName ?? c.externalRef ?? 'Contacto sin identificar'}</strong>
                  <time dateTime={c.lastActivityAt}>{formatTime(c.lastActivityAt, tz)}</time>
                </span>
                <span className="conv-preview">{c.lastMessage ? `${c.lastMessage.direction === 'OUT' ? `${SENDER[c.lastMessage.senderKind] ?? ''}: ` : ''}${c.lastMessage.body}` : 'Sin mensajes'}</span>
                <span className={`badge mode-${c.mode.toLowerCase()}`}>{modeLabel(c, me)}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section className="thread-pane" aria-label="Conversación seleccionada">
        {selected ? (
          <Thread key={selected} client={client} id={selected} tz={tz} canAct={canAct} isAdmin={isAdmin} onBack={() => setSelected(null)}
            onChanged={() => void load()} onUnauthorized={onUnauthorized} />
        ) : <p className="empty center">Elegí una conversación para leerla.</p>}
      </section>
    </div>
  );
}

const sortPending = (xs: Conversation[]) => [...xs].sort((a, b) => Number(b.mode === 'HUMAN_PENDING') - Number(a.mode === 'HUMAN_PENDING'));

function Thread({ client, id, tz, canAct, isAdmin, onBack, onChanged, onUnauthorized }: {
  client: Api; id: string; tz: string; canAct: boolean; isAdmin: boolean; onBack: () => void; onChanged: () => void; onUnauthorized: () => void;
}) {
  const [data, setData] = useState<{ me: string; conversation: Conversation; messages: Message[] } | null>(null);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const lastCount = useRef(0);

  const fail = useCallback((e: unknown) => {
    if ((e as Error).name === 'AbortError') return;
    if (e instanceof ApiError && e.status === 401) return onUnauthorized();
    setError((e as Error).message);
  }, [onUnauthorized]);

  const load = useCallback(async (signal?: AbortSignal) => {
    try { setData(await client.thread(id, signal)); setError(''); } catch (e) { fail(e); }
  }, [client, id, fail]);

  useEffect(() => {
    const ctl = new AbortController();
    void load(ctl.signal);
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, POLL_MS);
    return () => { ctl.abort(); clearInterval(t); };
  }, [load]);

  useEffect(() => {
    const n = data?.messages.length ?? 0;
    if (n !== lastCount.current) { lastCount.current = n; endRef.current?.scrollIntoView({ block: 'end' }); }
  }, [data]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true); setError('');
    try { await fn(); await load(); onChanged(); } catch (e) { fail(e); void load(); onChanged(); } finally { setBusy(false); }
  }
  async function send() {
    const body = draft.trim();
    if (!body) return;
    setBusy(true); setError('');
    try { await client.reply(id, body); setDraft(''); await load(); onChanged(); } catch (e) { fail(e); void load(); } finally { setBusy(false); }
  }

  if (!data) return error ? <Alert>{error}</Alert> : <p role="status" className="muted pad">Cargando…</p>;
  const { conversation: c, messages } = data;
  const mine = c.mode === 'HUMAN_ACTIVE' && c.assignedTo === data.me;
  const someoneElse = c.mode === 'HUMAN_ACTIVE' && !mine;

  return (
    <div className="thread">
      <header className="thread-head">
        <button type="button" className="btn ghost back" onClick={onBack}>‹ Volver</button>
        <div className="grow">
          <h2>{c.patientName ?? c.externalRef ?? 'Contacto sin identificar'}</h2>
          <p className="muted">{c.patientPhone ?? 'Paciente no identificado'} · {c.channel === 'WHATSAPP' ? 'WhatsApp' : 'Web'}</p>
        </div>
        <span className={`badge mode-${c.mode.toLowerCase()}`}>{modeLabel(c, data.me)}</span>
      </header>

      {c.mode === 'HUMAN_PENDING' && c.escalationReason && <p className="notice warn"><strong>Motivo del aviso:</strong> {c.escalationReason}</p>}
      {c.mode === 'BOT' && <p className="notice">Responde el asistente automático. Si tomás la conversación, deja de contestar.</p>}
      <p className="notice info">WhatsApp todavía no está conectado a un proveedor real: los envíos se simulan.</p>

      <div className="messages" role="log" aria-live="polite" aria-label="Mensajes">
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.direction === 'IN' ? 'in' : 'out'} sender-${m.senderKind.toLowerCase()}`}>
            <span className="msg-meta">{SENDER[m.senderKind] ?? m.senderKind} · {formatTime(m.createdAt, tz)}{m.direction === 'OUT' ? ` · ${DELIVERY[m.deliveryStatus] ?? m.deliveryStatus}` : ''}</span>
            <p>{m.body}</p>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      {error && <Alert>{error}</Alert>}

      {canAct && (
        <div className="thread-actions">
          {c.mode !== 'CLOSED' && !mine && !someoneElse && <button type="button" className="btn primary" disabled={busy} onClick={() => void act(() => client.takeover(id))}>Tomar conversación</button>}
          {mine && <button type="button" className="btn" disabled={busy} onClick={() => void act(() => client.release(id))}>Devolver al asistente</button>}
          {someoneElse && isAdmin && <button type="button" className="btn" disabled={busy} onClick={() => void act(() => client.release(id))}>Liberar (administrador)</button>}
          {c.mode !== 'CLOSED' && (mine || !someoneElse || isAdmin) && <button type="button" className="btn ghost" disabled={busy} onClick={() => void act(() => client.closeConversation(id))}>Cerrar conversación</button>}
        </div>
      )}

      {canAct && (
        <form className="composer" onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <label htmlFor="reply" className="sr-only">Tu respuesta</label>
          <textarea
            id="reply" rows={2} value={draft} maxLength={4000} disabled={!mine || busy}
            placeholder={mine ? 'Escribí tu respuesta (Ctrl+Enter para enviar)' : someoneElse ? 'Otra persona atiende esta conversación' : 'Tomá la conversación para responder'}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); } }}
          />
          <button type="submit" className="btn primary" disabled={!mine || busy || !draft.trim()}>Enviar</button>
        </form>
      )}
    </div>
  );
}
