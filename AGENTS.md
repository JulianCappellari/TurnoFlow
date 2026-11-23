# TurnoFlow: instrucciones para agentes (Codex, Claude Code u otros)

SaaS B2B multi-tenant para clínicas odontológicas argentinas: atención administrativa por WhatsApp con IA supervisada, agenda sin dobles reservas y bandeja humana.
**Lee primero** `docs/CODEX_GUIDE.md` (plan de trabajo detallado), luego `.ai-memory/PROJECT_CONTEXT.md`, `.ai-memory/ACTIVE_TASK.md` y `.ai-memory/handoffs/LATEST_HANDOFF.md`. La especificación está en `docs/product/ESPECIFICACION_INTEGRAL_2026.md` (es una propuesta, no aprobada).

## Alcance
- **Solo P0.** No implementes P1/P2 (pagos, matriz de obras sociales, Google Calendar, audios, lista de espera avanzada, reprogramación, recordatorios) salvo pedido explícito.
- Si una decisión abierta D-xx afecta seguridad, **bloqueá ese alcance** y trabajá en lo independiente (lista en la guía, sección 4).
- No crees integraciones reales ni uses datos de pacientes reales. WhatsApp y el modelo de lenguaje son simulados detrás de interfaces (`WhatsAppSender`, `LlmGateway`).
- No inventes consentimientos, tarifas ni reglas de negocio críticas: documentá la duda.

## Comandos (PowerShell, Windows)
```powershell
npm install
npm run db:up          # PostgreSQL 16 en Docker, puerto 54329 (datos en memoria: se pierden al bajar)
npm test               # DEBE pasar siempre; recrea la base turnoflow_test
npm run typecheck      # raíz + web
npm run test:stress    # 10.000 intentos concurrentes (~50 s), correr antes de tocar agenda
$env:DATABASE_URL="postgres://postgres:postgres@localhost:54329/turnoflow_dev"; $env:AUTH_SECRET="dev-only-secret-dev-only-secret-0123456789"
npm run dev:createdb ; npm run dev:seed ; npm run dev:api ; npm run dev:worker ; npm run dev:web
```
Las variables de entorno **no se cargan desde `.env`** (no hay dotenv): se exportan en la terminal. Ver `.env.example`.

## Invariantes que no se rompen (cada una tiene tests)
1. Nunca dos citas activas solapadas por profesional: lock advisory por agenda + restricciones EXCLUDE (`docs/adr/0001-scheduling-concurrency.md`).
2. Todo query lleva `tenant_id`; el tenant sale **solo** de la sesión verificada, jamás del body. IDs ajenos devuelven 404.
3. Todo el SQL vive en `packages/db`. La IA y la API no escriben tablas directamente.
4. La IA propone, el backend decide (`docs/adr/0002-ai-agent.md`): sin confirmar por texto, sin horarios inventados, urgencias y pedidos de humano sin modelo, si un humano toma la conversación el bot no escribe.
5. Los datos personales no van a logs, auditoría ni al proveedor de IA. `audit_events` es append-only.
6. Migraciones aplicadas no se editan: se agrega una nueva (`packages/db/migrations/00N_*.sql`).

## Cómo trabajar
- Cambio pequeño y verificable: tests primero o junto con el código, `npm test` y `npm run typecheck` en verde antes de terminar.
- Los tests de base usan PostgreSQL real; un tenant nuevo por test. Si un test usa workers/colas, acotalos con `tenantId` (los archivos de test corren en paralelo sobre la misma base).
- Los workers usan el reloj de la base de datos, no el de Node.
- Scripts con `tsx` (Node strip-types no soporta parameter properties).
- Textos visibles en español rioplatense (voseo). Horas siempre en la zona de la clínica.
- Al terminar: actualizá `.ai-memory` (ACTIVE_TASK, handoffs/LATEST_HANDOFF, history/TASK_LOG, DECISIONS si corresponde). No guardes secretos ni datos personales.
- No hagas commits, push, deploy ni operaciones destructivas sin que el usuario lo pida.
- Si editás archivos con scripts de shell largos, ojo con heredocs y barras invertidas (`\b` en regex se corrompió una vez): preferí herramientas de edición de archivos.
