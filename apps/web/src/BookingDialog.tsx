import { useEffect, useRef, useState } from 'react';
import { ApiError, type Api, type Catalog, type Patient, type Slot } from './api.ts';
import { Alert, Dialog } from './ui.tsx';
import { addDays, dayRange, formatDateTimeLong, formatTime, todayIn } from './time.ts';

interface Props {
  client: Api; catalog: Catalog; initialDay: string; onClose: () => void; onUnauthorized: () => void;
  onBooked: (message: string, day: string) => void;
}

const newKey = () => `ui-${crypto.randomUUID()}`;

export function BookingDialog({ client, catalog, initialDay, onClose, onUnauthorized, onBooked }: Props) {
  const tz = catalog.clinic.timezone;
  const [serviceId, setServiceId] = useState(catalog.services[0]?.id ?? '');
  const [professionalId, setProfessionalId] = useState('');
  const [day, setDay] = useState(initialDay);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [slotError, setSlotError] = useState('');
  const [patient, setPatient] = useState<Patient | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  // One Idempotency-Key per user intent: a retry after a network error must not create a second booking.
  const attempt = useRef<{ key: string; slot: string; patient: string; hold?: { holdId: string; token: string } } | null>(null);

  const professionals = catalog.professionals.filter((p) => p.serviceIds.includes(serviceId));
  const nameOf = (id: string) => catalog.professionals.find((p) => p.id === id)?.name ?? '';

  useEffect(() => {
    if (!serviceId || !day) return;
    const ctl = new AbortController();
    setSlots(null); setSlot(null); setSlotError('');
    const { from, to } = dayRange(day, tz);
    client.availability(catalog.clinic.id, serviceId, from, to, professionalId || undefined, ctl.signal).then(
      (r) => setSlots(r.slots),
      (e: Error) => {
        if (e.name === 'AbortError') return;
        if (e instanceof ApiError && e.status === 401) return onUnauthorized();
        setSlotError(e.message); setSlots([]);
      },
    );
    return () => ctl.abort();
  }, [client, catalog.clinic.id, serviceId, professionalId, day, tz, reload, onUnauthorized]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!slot || !patient) return;
    setSubmitting(true); setError('');
    const sig = { slot: `${slot.professionalId}@${slot.startsAt}`, patient: patient.id };
    if (!attempt.current || attempt.current.slot !== sig.slot || attempt.current.patient !== sig.patient) {
      attempt.current = { key: newKey(), ...sig };
    }
    try {
      if (!attempt.current.hold) {
        const h = await client.hold(slot.professionalId, serviceId, slot.startsAt);
        attempt.current.hold = { holdId: h.holdId, token: h.confirmationToken };
      }
      await client.confirm(attempt.current.hold.holdId, patient.id, attempt.current.hold.token, attempt.current.key);
      onBooked(`Turno confirmado para ${patient.fullName}: ${formatDateTimeLong(slot.startsAt, tz)}.`, day);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onUnauthorized();
      const retriable = !(err instanceof ApiError) || err.status === 0 || err.status >= 500;
      if (!retriable) attempt.current = null; // definitive answer: next try starts clean
      setError((err as Error).message);
      if (err instanceof ApiError && (err.code === 'SLOT_TAKEN' || err.code === 'SLOT_NOT_OFFERED' || err.code === 'HOLD_EXPIRED')) setReload((n) => n + 1);
      setSubmitting(false);
    }
  }

  const ready = !!slot && !!patient && !submitting;

  return (
    <Dialog title="Nuevo turno" onClose={onClose} wide>
      <form onSubmit={submit} className="stack" noValidate>
        <div className="fields">
          <label className="field"><span>Práctica</span>
            <select value={serviceId} onChange={(e) => { setServiceId(e.target.value); setProfessionalId(''); }}>
              {catalog.services.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.durationMin} min</option>)}
            </select>
          </label>
          <label className="field"><span>Profesional</span>
            <select value={professionalId} onChange={(e) => setProfessionalId(e.target.value)}>
              <option value="">Cualquiera disponible</option>
              {professionals.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label className="field"><span>Fecha</span>
            <input type="date" value={day} min={todayIn(tz)} max={addDays(todayIn(tz), 90)} onChange={(e) => e.target.value && setDay(e.target.value)} />
          </label>
        </div>

        <fieldset className="slots">
          <legend>Horarios disponibles <span className="muted">({tz.replace(/_/g, ' ')})</span></legend>
          {slotError && <Alert>{slotError}</Alert>}
          {!slots && <p role="status" className="muted">Buscando horarios…</p>}
          {slots && slots.length === 0 && !slotError && <p className="muted">No hay horarios libres ese día. Probá con otra fecha o profesional.</p>}
          <div className="chips">
            {slots?.map((s) => {
              const on = slot?.startsAt === s.startsAt && slot.professionalId === s.professionalId;
              return (
                <button key={`${s.professionalId}${s.startsAt}`} type="button" className={`chip${on ? ' on' : ''}`} aria-pressed={on} onClick={() => setSlot(s)}>
                  <strong>{formatTime(s.startsAt, tz)}</strong>
                  {!professionalId && <span>{nameOf(s.professionalId)}</span>}
                </button>
              );
            })}
          </div>
        </fieldset>

        <PatientPicker client={client} patient={patient} onPick={setPatient} onUnauthorized={onUnauthorized} />

        {slot && patient && (
          <p className="summary">
            Vas a agendar a <strong>{patient.fullName}</strong> con <strong>{nameOf(slot.professionalId)}</strong> el{' '}
            <strong>{formatDateTimeLong(slot.startsAt, tz)}</strong>.
          </p>
        )}
        {error && <Alert>{error}</Alert>}
        <div className="row end">
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
          <button type="submit" className="btn primary" disabled={!ready}>{submitting ? 'Confirmando…' : 'Confirmar turno'}</button>
        </div>
        {!ready && !submitting && <p className="hint">{!slot ? 'Elegí un horario.' : 'Elegí o creá un paciente.'}</p>}
      </form>
    </Dialog>
  );
}

function PatientPicker({ client, patient, onPick, onUnauthorized }: {
  client: Api; patient: Patient | null; onPick: (p: Patient | null) => void; onUnauthorized: () => void;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Patient[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (q.trim().length < 2) { setResults(null); return; }
    const ctl = new AbortController();
    const t = setTimeout(() => {
      client.searchPatients(q, ctl.signal).then((r) => setResults(r.patients), (e: Error) => {
        if (e.name === 'AbortError') return;
        if (e instanceof ApiError && e.status === 401) return onUnauthorized();
        setError(e.message);
      });
    }, 250);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [client, q, onUnauthorized]);

  async function create() {
    setBusy(true); setError('');
    try {
      const p = await client.createPatient(name, phone);
      onPick(p); setCreating(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return onUnauthorized();
      setError((e as Error).message);
    } finally { setBusy(false); }
  }

  if (patient) {
    return (
      <div className="patient-chosen">
        <span><strong>{patient.fullName}</strong> · {patient.phone}</span>
        <button type="button" className="btn ghost" onClick={() => onPick(null)}>Cambiar</button>
      </div>
    );
  }
  return (
    <fieldset className="patient">
      <legend>Paciente</legend>
      {!creating ? (
        <>
          <label className="field"><span>Buscar por nombre o teléfono</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
          </label>
          <div aria-live="polite">
            {results && results.length === 0 && <p className="muted">Sin resultados.</p>}
            {results && results.length > 0 && (
              <ul className="results">
                {results.map((p) => (
                  <li key={p.id}><button type="button" onClick={() => onPick(p)}><strong>{p.fullName}</strong><span>{p.phone}</span></button></li>
                ))}
              </ul>
            )}
          </div>
          {error && <Alert>{error}</Alert>}
          <button type="button" className="btn ghost" onClick={() => { setCreating(true); setError(''); }}>+ Paciente nuevo</button>
        </>
      ) : (
        <div className="stack">
          <label className="field"><span>Nombre completo</span><input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" /></label>
          <label className="field"><span>Teléfono (con código de país)</span>
            <input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" placeholder="+54 9 11 2233-4455" autoComplete="off" />
          </label>
          {error && <Alert>{error}</Alert>}
          <div className="row">
            <button type="button" className="btn" onClick={() => setCreating(false)}>Volver a buscar</button>
            <button type="button" className="btn primary" disabled={busy || name.trim().length < 2 || phone.trim().length < 7} onClick={() => void create()}>
              {busy ? 'Guardando…' : 'Guardar paciente'}
            </button>
          </div>
        </div>
      )}
    </fieldset>
  );
}
