import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, api, peekRole, type Catalog } from './api.ts';
import { Agenda } from './Agenda.tsx';
import { BookingDialog } from './BookingDialog.tsx';
import { Inbox } from './Inbox.tsx';
import { addDays, formatDayLong, todayIn, tzLabel } from './time.ts';

const KEY = 'turnoflow.token';
const readToken = (): string => { try { return sessionStorage.getItem(KEY) ?? ''; } catch { return ''; } };
const writeToken = (t: string) => { try { t ? sessionStorage.setItem(KEY, t) : sessionStorage.removeItem(KEY); } catch { /* storage unavailable */ } };

export function App() {
  const [token, setToken] = useState(readToken);
  const login = (t: string) => { writeToken(t); setToken(t); };
  const logout = useCallback(() => { writeToken(''); setToken(''); }, []);
  return token ? <Panel token={token} onLogout={logout} /> : <Login onLogin={login} />;
}

function Login({ onLogin }: { onLogin: (t: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <main className="login">
      <form onSubmit={(e) => { e.preventDefault(); if (value.trim()) onLogin(value.trim()); }}>
        <h1>TurnoFlow</h1>
        <p className="muted">Panel de recepción</p>
        <label htmlFor="token">Token de sesión</label>
        <textarea id="token" rows={4} value={value} onChange={(e) => setValue(e.target.value)} spellCheck={false} autoComplete="off" required />
        <p className="hint">Entorno de desarrollo: generá un token con <code>npm run dev:seed</code>. El acceso real con usuario y verificación en dos pasos llega con el proveedor de identidad.</p>
        <button className="btn primary" type="submit">Ingresar</button>
      </form>
    </main>
  );
}

function Panel({ token, onLogout }: { token: string; onLogout: () => void }) {
  const client = useMemo(() => api(token), [token]);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState('');
  const [day, setDay] = useState('');
  const [professionalId, setProfessionalId] = useState('');
  const [booking, setBooking] = useState(false);
  const [version, setVersion] = useState(0);
  const [toast, setToast] = useState('');
  const [view, setView] = useState<'agenda' | 'inbox'>('agenda');
  const [pending, setPending] = useState(0);
  const role = peekRole(token);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { clinics } = await client.clinics();
        if (!clinics[0]) throw new ApiError(404, 'NOT_FOUND', 'Esta cuenta todavía no tiene una sede configurada.');
        const cat = await client.catalog(clinics[0].id);
        if (!alive) return;
        setCatalog(cat);
        setDay(todayIn(cat.clinic.timezone));
      } catch (e) {
        if (!alive) return;
        if (e instanceof ApiError && e.status === 401) return onLogout();
        setError((e as Error).message);
      }
    })();
    return () => { alive = false; };
  }, [client, onLogout]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  // Keep the "waiting for a person" badge fresh while the agenda is showing (the inbox view updates it itself).
  useEffect(() => {
    if (!catalog || view !== 'agenda') return;
    const tick = () => { if (document.visibilityState === 'visible') client.conversations('HUMAN_PENDING').then((r) => setPending(r.items.length), () => undefined); };
    tick();
    const t = setInterval(tick, 15000);
    return () => clearInterval(t);
  }, [client, catalog, view]);

  if (error) return <main className="login"><div><p role="alert" className="alert">{error}</p><button className="btn" onClick={onLogout}>Volver a ingresar</button></div></main>;
  if (!catalog) return <main className="login"><p role="status" className="muted">Cargando…</p></main>;
  const tz = catalog.clinic.timezone;
  const canBook = role === 'owner' || role === 'admin_clinic' || role === 'receptionist';

  return (
    <div className="shell">
      <a className="skip" href="#agenda">Saltar a la agenda</a>
      <header className="topbar">
        <div className="brand">
          <strong>TurnoFlow</strong>
          <span className="muted">{catalog.clinic.name}</span>
        </div>
        <nav className="tabs" aria-label="Secciones">
          <button type="button" className={view === 'agenda' ? 'on' : ''} aria-current={view === 'agenda' ? 'page' : undefined} onClick={() => setView('agenda')}>Agenda</button>
          <button type="button" className={view === 'inbox' ? 'on' : ''} aria-current={view === 'inbox' ? 'page' : undefined} onClick={() => setView('inbox')}>
            Bandeja{pending > 0 && <span className="count" aria-label={`${pending} esperando a una persona`}>{pending}</span>}
          </button>
        </nav>
        {view === 'agenda' && <><div className="datenav" role="group" aria-label="Elegir día">
          <button className="btn" onClick={() => setDay(addDays(day, -1))} aria-label="Día anterior">‹</button>
          <input type="date" aria-label="Fecha" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} />
          <button className="btn" onClick={() => setDay(addDays(day, 1))} aria-label="Día siguiente">›</button>
          <button className="btn" onClick={() => setDay(todayIn(tz))}>Hoy</button>
        </div>
        <label className="inline">
          <span>Profesional</span>
          <select value={professionalId} onChange={(e) => setProfessionalId(e.target.value)}>
            <option value="">Todos</option>
            {catalog.professionals.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label></>}
        <div className="actions">
          {canBook && view === 'agenda' && <button className="btn primary" onClick={() => setBooking(true)}>Nuevo turno</button>}
          <button className="btn ghost" onClick={onLogout}>Salir</button>
        </div>
      </header>
      {view === 'agenda' ? (
        <>
          <div className="subbar"><h1 className="day-title">{formatDayLong(day)}</h1><span className="muted">Horarios en {tzLabel(tz)}</span></div>
          <main id="agenda" tabIndex={-1}>
            <Agenda
              client={client} catalog={catalog} day={day} professionalId={professionalId} version={version} canCancel={canBook}
              onUnauthorized={onLogout} onChanged={(msg) => { refresh(); setToast(msg); }}
            />
          </main>
        </>
      ) : (
        <main id="agenda" tabIndex={-1} className="inbox-main">
          <h1 className="sr-only">Bandeja de conversaciones</h1>
          <Inbox
            client={client} tz={tz} canAct={canBook} isAdmin={role === 'owner' || role === 'admin_clinic'}
            onUnauthorized={onLogout} onPendingCount={setPending}
          />
        </main>
      )}
      {booking && (
        <BookingDialog
          client={client} catalog={catalog} initialDay={day} onClose={() => setBooking(false)} onUnauthorized={onLogout}
          onBooked={(msg, bookedDay) => { setBooking(false); setDay(bookedDay); refresh(); setToast(msg); }}
        />
      )}
      <div className="toast-region" role="status" aria-live="polite">{toast && <p className="toast">{toast}</p>}</div>
    </div>
  );
}
