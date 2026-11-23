# Frontend (VERIFIED by build, typecheck and manual browser checks; no automated UI tests)

Vite + React 18, no UI library, no router, no external fonts (system fonts, privacy and weight). One CSS file with tokens, light/dark via `prefers-color-scheme`. Dev proxy `/api` -> `127.0.0.1:3000` (`apps/web/vite.config.ts`). Bundle about 55 KB gzip.

Files: `App.tsx` (login by pasted token, tabs Agenda/Bandeja, toasts, pending-count badge), `Agenda.tsx` (day grid per professional, appointment dialog, two-step cancel), `BookingDialog.tsx` (service/professional/date -> real slots -> patient search/create -> hold+confirm with ONE Idempotency-Key per user intent), `Inbox.tsx` (list, filters, thread, takeover/release/close, composer, 8 s polling), `api.ts` (typed client + Spanish error messages), `time.ts` (clinic-timezone helpers, unit tested), `ui.tsx` (`<dialog>` wrapper, alerts).

Conventions: all user-visible text in Spanish (es-AR, voseo); times always shown in the clinic timezone with the zone visible; every control has an accessible name; modals use native `<dialog>`; no color-only status (badges carry text); polling pauses when the tab is hidden.

Token is kept in `sessionStorage` (interim; move to HttpOnly cookie when real identity lands).

Missing screens (spec 16.1): `/rules` and `/settings` (clinic/professional/service/schedule administration, blocks and holidays), `/patients` directory, `/reports` and dashboard (RF-047), `/onboarding`, `/invite/accept`, privacy requests, incident/degraded-mode panel (RF-052).
