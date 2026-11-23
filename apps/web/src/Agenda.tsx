import { useEffect, useMemo, useState } from 'react';
import { ApiError, type Api, type AgendaItem, type Catalog } from './api.ts';
import { Alert, Dialog, STATUS_LABEL } from './ui.tsx';
import { dayRange, formatDateTimeLong, formatTime, minutesOfDay } from './time.ts';

const HOUR_PX = 72;

interface Props {
  client: Api; catalog: Catalog; day: string; professionalId: string; version: number; canCancel: boolean;
  onUnauthorized: () => void; onChanged: (message: string) => void;
}

export function Agenda({ client, catalog, day, professionalId, version, canCancel, onUnauthorized, onChanged }: Props) {
  const tz = catalog.clinic.timezone;
  const [items, setItems] = useState<AgendaItem[] | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<AgendaItem | null>(null);

  useEffect(() => {
    if (!day) return;
    const ctl = new AbortController();
    setItems(null); setError('');
    const { from, to } = dayRange(day, tz);
    client.agenda(catalog.clinic.id, from, to, ctl.signal).then(
      (r) => setItems(r.items),
      (e: Error) => {
        if (e.name === 'AbortError') return;
        if (e instanceof ApiError && e.status === 401) return onUnauthorized();
        setError(e.message);
      },
    );
    return () => ctl.abort();
  }, [client, catalog.clinic.id, day, tz, version, onUnauthorized]);

  const columns = catalog.professionals.filter((p) => !professionalId || p.id === professionalId);
  const { startHour, endHour } = useMemo(() => {
    let s = 8; let e = 20;
    for (const i of items ?? []) {
      s = Math.min(s, Math.floor(minutesOfDay(i.startsAt, tz) / 60));
      const end = minutesOfDay(i.endsAt, tz);
      e = Math.max(e, Math.ceil((end === 0 ? 1440 : end) / 60));
    }
    return { startHour: s, endHour: e };
  }, [items, tz]);

  if (error) return <Alert>{error}</Alert>;
  if (!items) return <p role="status" className="muted pad">Cargando agenda…</p>;

  const active = items.filter((i) => i.status !== 'CANCELLED');
  const hours = Array.from({ length: endHour - startHour }, (_, i) => startHour + i);

  return (
    <>
      {active.length === 0 && <p className="empty">No hay turnos para este día. Usá «Nuevo turno» para agendar.</p>}
      <div className="grid-scroll">
        <div className="grid" style={{ gridTemplateColumns: `4rem repeat(${columns.length}, minmax(15rem, 1fr))` }}>
          <div className="corner" />
          {columns.map((p) => (
            <div key={p.id} className="col-head"><strong>{p.name}</strong><span className="muted">{p.specialty}</span></div>
          ))}
          <div className="hours" style={{ height: hours.length * HOUR_PX }}>
            {hours.map((h) => <span key={h} style={{ top: (h - startHour) * HOUR_PX }}>{String(h).padStart(2, '0')}:00</span>)}
          </div>
          {columns.map((p) => (
            <div key={p.id} className="col" style={{ height: hours.length * HOUR_PX, ['--hour' as string]: `${HOUR_PX}px` }}>
              {items.filter((i) => i.professionalId === p.id).map((i) => {
                const top = ((minutesOfDay(i.startsAt, tz) - startHour * 60) / 60) * HOUR_PX;
                const mins = Math.max(15, (new Date(i.endsAt).getTime() - new Date(i.startsAt).getTime()) / 60_000);
                return (
                  <button
                    key={i.id} type="button" className={`appt status-${i.status.toLowerCase()}${mins <= 30 ? ' short' : ''}`}
                    style={{ top: top + 1, height: Math.max(30, (mins / 60) * HOUR_PX - 3) }}
                    onClick={() => setSelected(i)}
                    aria-label={`${formatTime(i.startsAt, tz)} a ${formatTime(i.endsAt, tz)}, ${i.patientName}, ${i.serviceName}, ${STATUS_LABEL[i.status] ?? i.status}`}
                  >
                    <span className="appt-time">{formatTime(i.startsAt, tz)}–{formatTime(i.endsAt, tz)}</span>
                    <span className="appt-name">{i.patientName}</span>
                    {mins >= 30 && <span className="appt-meta">{i.serviceName}{i.status !== 'CONFIRMED' ? ` · ${STATUS_LABEL[i.status] ?? i.status}` : ''}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      {selected && (
        <AppointmentDialog
          client={client} item={selected} tz={tz} professionalName={catalog.professionals.find((p) => p.id === selected.professionalId)?.name ?? ''}
          canCancel={canCancel} onClose={() => setSelected(null)} onUnauthorized={onUnauthorized}
          onCancelled={(msg) => { setSelected(null); onChanged(msg); }}
        />
      )}
    </>
  );
}

function AppointmentDialog({ client, item, tz, professionalName, canCancel, onClose, onUnauthorized, onCancelled }: {
  client: Api; item: AgendaItem; tz: string; professionalName: string; canCancel: boolean;
  onClose: () => void; onUnauthorized: () => void; onCancelled: (message: string) => void;
}) {
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function cancel() {
    setBusy(true); setError('');
    try {
      await client.cancel(item.id, reason.trim() || undefined);
      onCancelled(`Turno de ${item.patientName} cancelado.`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return onUnauthorized();
      setError((e as Error).message); setBusy(false);
    }
  }

  return (
    <Dialog title="Detalle del turno" onClose={onClose}>
      <dl className="details">
        <dt>Paciente</dt><dd>{item.patientName}</dd>
        <dt>Teléfono</dt><dd>{item.patientPhone}</dd>
        <dt>Práctica</dt><dd>{item.serviceName}</dd>
        <dt>Profesional</dt><dd>{professionalName}</dd>
        <dt>Cuándo</dt><dd>{formatDateTimeLong(item.startsAt, tz)} a {formatTime(item.endsAt, tz)}</dd>
        <dt>Estado</dt><dd>{STATUS_LABEL[item.status] ?? item.status}</dd>
      </dl>
      {error && <Alert>{error}</Alert>}
      {canCancel && item.status === 'CONFIRMED' && !asking && (
        <div className="row end"><button className="btn danger-outline" onClick={() => setAsking(true)}>Cancelar turno…</button></div>
      )}
      {asking && (
        <form onSubmit={(e) => { e.preventDefault(); void cancel(); }} className="stack">
          <p><strong>¿Cancelar este turno?</strong> El horario vuelve a quedar disponible. Esta acción queda registrada.</p>
          <label htmlFor="reason">Motivo (opcional)</label>
          <input id="reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} autoFocus />
          <div className="row end">
            <button type="button" className="btn" onClick={() => setAsking(false)} disabled={busy}>Volver</button>
            <button type="submit" className="btn danger" disabled={busy}>{busy ? 'Cancelando…' : 'Sí, cancelar turno'}</button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
