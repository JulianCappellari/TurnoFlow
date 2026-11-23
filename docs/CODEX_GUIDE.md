# Guía para continuar TurnoFlow (Codex u otro agente)

Estado al **2026-11-23**. Todo lo que dice "verificado" fue comprobado con tests o ejecución real en esta fecha (198 tests, typecheck y build en verde).
Leé también `AGENTS.md` (reglas cortas) y `.ai-memory/` (memoria de continuidad).

---

## 0. Veredicto: ¿está listo para que lo siga Codex?

**Sí, para seguir desarrollando P0. No, para producción ni para pacientes reales.**

| Tema | Estado |
|---|---|
| Núcleo de agenda (esquema, reservas sin solapamiento, holds, idempotencia) | Hecho y verificado (TC-020, TC-021/022, TC-040, TC-100, 10.000 intentos) |
| API HTTP de agenda, pacientes, bandeja, webhook firmado | Hecha y verificada |
| Panel de recepción (Agenda + Bandeja) | Hecho; probado a mano, **sin tests automáticos de interfaz** |
| Worker (ingesta, expiración de holds, agente, despacho) | Hecho; usa proveedor y modelo **simulados** |
| Agente de IA (política, herramientas, guardas) | Hecho con modelo **simulado** |
| Identidad real, MFA, invitaciones | **No existe** (hay un token HS256 provisorio) |
| Administración (clínicas, profesionales, servicios, horarios, feriados) | **No existe** en API ni en la interfaz (solo el seed) |
| Privacidad (exportar, rectificar, suprimir, retención) | **No existe** |
| Observabilidad, alertas, tablero, modo degradado en el panel | **No existe** |
| CI, lint, OpenAPI, pruebas E2E y de carga, Docker de despliegue | **No existe** |
| Git | Repositorio `main` con primer commit local y remoto `origin` configurado (WP0 parcialmente hecho: falta CI y lint) |

Huecos conocidos que Codex debe tener presentes (están en los paquetes de trabajo):
1. `git init` y el primer commit ya están hechos; falta CI y lint (WP0).
2. El despachador **no respeta la ventana de 24 h de WhatsApp** ni tiene opt-out (RF-023, RN-021). Hoy es inocuo porque el proveedor es simulado; es obligatorio antes de conectar uno real (WP10).
3. Los eventos `appointment.confirmed` y `appointment.cancelled` se acumulan en la cola sin consumidor (no pasa nada malo; los usarán recordatorios y sincronización, que son P1).
4. La carpeta está dentro de OneDrive: `node_modules` y la sincronización pelean. Mover el repositorio a una ruta fuera de OneDrive (por ejemplo `C:\dev\turnoflow`).
5. La base de desarrollo es **efímera** (tmpfs): se pierde al bajar el contenedor. Es intencional.

---

## 1. Puesta en marcha (15 minutos)

Requisitos: Node 24, npm 11, Docker Desktop.

```powershell
cd <ruta-del-repo>
npm install
npm run db:up                      # PostgreSQL 16 en el puerto 54329
npm test                           # esperado: 198 passed, 1 skipped
npm run typecheck                  # esperado: sin errores
```

Entorno de desarrollo (las variables **no** se cargan de `.env`: se definen en la terminal):

```powershell
$env:DATABASE_URL="postgres://postgres:postgres@localhost:54329/turnoflow_dev"
$env:AUTH_SECRET="dev-only-secret-dev-only-secret-0123456789"       # 32+ caracteres
$env:WHATSAPP_APP_SECRET="dev-wa-secret-0123456789abcdef"            # 16+ caracteres
$env:WHATSAPP_VERIFY_TOKEN="dev-wa-verify-0123456789abcdef"          # 16+ caracteres
npm run dev:createdb               # crea turnoflow_dev si no existe
npm run dev:seed                   # clínica demo sintética + imprime un TOKEN de ingreso
```

Tres terminales:

```powershell
npm run dev:api                    # http://127.0.0.1:3000
npm run dev:worker                 # ingesta, expiración de holds, agente, despacho (todo simulado)
npm run dev:web                    # http://localhost:5173 (pegar el token en el login)
```

Probar el flujo completo del agente (el número de Valentina Rossi está vinculado a una paciente del seed):

```powershell
npm run dev:wa -- "Hola" 5491155550101
npm run dev:wa -- "Quiero un turno para una consulta" 5491155550101
npm run dev:wa -- "2" 5491155550101
npm run dev:wa -- "sí" 5491155550101
```

Resultado esperado: el turno aparece en la Agenda y la conversación en la Bandeja con respuestas del Asistente.
Urgencia: `npm run dev:wa -- "Me duele muchísimo y me sangra" 5491177770001` crea una conversación "Espera a una persona" sin llamar al modelo.

---

## 2. Mapa del proyecto

```
apps/api       Fastify: auth provisoria, RBAC, rutas, webhook, scripts dev (seed, simulador)
apps/web       Vite + React: login por token, Agenda, Bandeja
apps/worker    Bucles: ingesta -> expiración de holds -> agente -> despacho
packages/domain       Lógica pura: slots (luxon), máquinas de estado, códigos de error
packages/db           Migraciones 001-004 y TODO el SQL: SchedulingService, InboxService, DirectoryService, messaging, agent store
packages/ai-policy    Agente: guardas, herramientas estrictas, orquestador, jobs, modelo SIMULADO
docs/adr              Decisiones (0001 concurrencia, 0002 agente)
docs/product          Especificación integral (copia)
.ai-memory            Memoria de continuidad entre agentes
```

Documentos que explican cada capa con detalle: `.ai-memory/architecture/{SYSTEM,DATABASE,API,BACKEND,FRONTEND}.md` y `.ai-memory/business/{RULES,PERMISSIONS,WORKFLOWS}.md`.

---

## 3. Reglas de trabajo

### 3.1 Alcance
- **Solo P0** (etiqueta `P0` en la especificación, secciones 6 y 5.1). No P1/P2.
- Si una decisión abierta bloquea algo (sección 4), implementá el mecanismo configurable, dejalo **apagado/conservador** y documentá qué falta decidir.

### 3.2 Bucle por tarea
1. Leé `.ai-memory/ACTIVE_TASK.md` y `LATEST_HANDOFF.md`. Verificá que `npm test` pase **antes** de tocar nada.
2. Escribí el objetivo y los criterios de aceptación en `ACTIVE_TASK.md`.
3. Diseñá el cambio mínimo: contratos, migración (si hace falta), reglas RBAC/tenant, tests de aceptación.
4. Implementá en este orden: migración -> dominio/servicio (`packages/db`) -> ruta de API -> pantalla -> tests en cada capa.
5. `npm test` y `npm run typecheck` en verde. Si tocaste agenda: también `npm run test:stress`.
6. Si es visible en la interfaz: probalo en el navegador (escritorio y 375 px), consola sin errores, sin scroll horizontal de página, controles con nombre accesible.
7. Actualizá `.ai-memory` (tarea, handoff, decisiones). Informá qué probaste y qué no.

### 3.3 Definition of Done
Código con tests; autorización y tenant verificados en el servidor; errores como `problem+json`; auditoría de acciones sensibles (sin datos personales); migración nueva (nunca editar una aplicada); documentación; textos en español rioplatense; **nada se da por terminado si solo compila**.

### 3.4 Invariantes (no se rompen)
1. Dos citas activas no pueden solaparse por profesional. Lock advisory por agenda **más** restricciones EXCLUDE (ADR 0001). No reemplazar por `SELECT FOR UPDATE` solamente.
2. Cada query filtra por `tenant_id`; el tenant sale solo de la sesión; ids ajenos dan 404.
3. SQL solo en `packages/db`.
4. IA: propone, el backend decide. Nada se confirma por texto del modelo; los horarios son referencias opacas ofrecidas por el sistema; urgencias, pedido de persona y "no" a una reserva se resuelven sin modelo; si un humano toma la conversación el bot no escribe (versión de conversación).
5. Cero datos personales en logs, `audit_events`, `outbox_events.payload_min` o prompts al modelo.
6. Los workers usan el reloj de la base. Las colas se reclaman con `FOR UPDATE SKIP LOCKED` y tiempo de visibilidad.
7. Toda llamada externa lenta (modelo, proveedor) **fuera** de una transacción.

### 3.4.1 Trampas conocidas (ya costaron tiempo)
- Los archivos de test corren en paralelo sobre una misma base: acotá workers y colas con `tenantId` en los tests.
- No mezclar `new Date()` de Node con `now()` de la base en reclamos de cola.
- Node strip-types no ejecuta *parameter properties*: los scripts usan `tsx`.
- Un cliente de transacción de `pg` no admite consultas concurrentes (`Promise.all` sobre el mismo `client`).
- `<dialog>` en React StrictMode: no llamar `close()` en el cleanup del efecto.
- Al editar con scripts de shell, las barras invertidas de regex (`\b`) pueden corromperse: usar herramientas de edición de archivos.

---

## 4. Decisiones abiertas (sección 23 de la especificación) y qué bloquean

| ID | Pendiente | Bloquea | Qué hacer mientras tanto |
|---|---|---|---|
| D-03/D-13/D-14 | Rol legal, contratos de datos, región, responsable de incidentes | Modelo de lenguaje real, proveedor real, producción | Todo simulado; documentar en `DATA_PROCESSING.md` |
| D-04 | Consentimiento y baja (opt-out) | Mensajes automáticos fuera de conversación, alta de pacientes por el agente | Mecanismo configurable y apagado (WP4/WP10) |
| D-05 | ¿WhatsApp permite este caso de uso bajo los términos vigentes? | Cliente real de WhatsApp | Revisar la forma de los payloads contra documentación oficial antes de cualquier tráfico real |
| D-06 | Cómo identificar al paciente para cancelar/reprogramar por chat | Cancelación por el agente | El agente siempre deriva (ya implementado) |
| D-09 | Dueño de la agenda (interna vs calendario externo) | Google Calendar (P1) | Fuente de verdad interna (ya es así) |
| D-10 | Retención de mensajes/audios | Purga de mensajes | Purga técnica de `inbox_events` sí; mensajes configurables y desactivados |
| D-11 | Precio, setup, límites de uso | Límites por plan | Solo alertas de costo |
| D-12 | Atención fuera de horario / urgencias | Promesas de respuesta | Los textos no prometen tiempos (ya es así) |

Antes de cada paquete, si necesita una de estas decisiones: **preguntá una sola vez al usuario** y seguí con lo independiente.

---

## 5. Plan de trabajo por paquetes (WP)

Orden recomendado: **WP0 -> WP1 -> WP2 -> WP3 -> WP4 -> WP5 -> WP6 -> WP7 -> WP9 -> WP10**; WP8 y WP12 son continuos; WP11 al final. WP1 es el mayor bloqueo para un piloto.

### WP0. Higiene del repositorio (0,5 día)
**Objetivo:** historial, CI y calidad mínima.
**Cómo:**
1. Mover el repo fuera de OneDrive. `git init`, agregar `.gitattributes` (`* text=auto eol=lf`), primer commit "base verificada" (**pedir permiso al usuario para commitear**).
2. `.nvmrc` con `24`, y `"engines": {"node": ">=24"}` en el `package.json` raíz.
3. ESLint (flat config) + Prettier con reglas mínimas (`no-floating-promises`, `eqeqeq`); script `npm run lint`.
4. `.github/workflows/ci.yml`: Node 24, servicio `postgres:16` (puerto 5432; usar `TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/turnoflow_test`), pasos `npm ci`, `lint`, `typecheck`, `test`. Job nocturno aparte para `test:stress`.
5. `npm audit --omit=dev` en CI (falla en vulnerabilidades altas), Dependabot semanal.
**Aceptación:** el CI pasa en un PR vacío; `npm run lint` limpio.

### WP1. Identidad, sesiones, MFA e invitaciones (RF-003, RF-004, RF-005; US-001/002; UC-01 precondición)
**Objetivo:** reemplazar el token HS256 provisorio por acceso real, manteniendo la forma `Session {userId, tenantId, role}`.
**Decisión previa (preguntar al usuario):** proveedor de identidad gestionado (Auth0, Clerk, Keycloak, Supabase Auth, etc.) o propio. La especificación sugiere gestionado con MFA. Recomendación: **un adaptador** `AuthProvider` en `apps/api/src/auth/` con una implementación real y otra de test, para no atarse.
**Cómo:**
1. Migración `005_identity.sql`: `invitations(id, tenant_id, email, role, token_hash, expires_at, used_at, created_by, created_at)`; `memberships.session_epoch int default 1` (se incrementa al revocar); `professionals.user_id uuid null` (vínculo profesional-usuario, para que `practitioner` vea solo su agenda).
2. Rutas: `POST /auth/invitations` (permiso `admin`: owner/admin_clinic; token aleatorio de un uso, se guarda su hash, vence), `POST /auth/invitations/accept`, `DELETE /memberships/:userId` (revocación: sube `session_epoch`).
3. En cada request: validar el token del proveedor, resolver `users.external_auth_id` -> membresía activa del tenant, **comparar `session_epoch`** (revocación inmediata, RF-003), construir `Session`.
4. MFA obligatorio para `owner` y `admin_clinic` (RF-005): rechazar sesiones sin MFA para esos roles (claim del proveedor). Bloqueo/limitación de intentos (ver WP2).
5. Cookies `HttpOnly; Secure; SameSite=Lax` + protección CSRF para métodos que cambian estado (doble envío de token o cabecera personalizada verificada).
6. Web: pantallas `/login` y `/invite/accept`; quitar el login por pegado de token (dejarlo solo con `import.meta.env.DEV`).
7. `support_limited`: acceso **solo con concesión temporal auditada** (tabla `access_grants`: quién, tenant, motivo, vence); sin concesión no ve nada (US-003).
8. `practitioner`: filtrar agenda por `professionals.user_id = session.userId`.
9. Sacar `signSessionToken` del camino de producción; dejar un helper solo para tests.
**Tests:** invitación de un solo uso y vencida (422), usuario revocado recibe 401 en la siguiente request, owner sin MFA rechazado, CSRF, practitioner no ve agenda ajena, support_limited sin concesión = 403 + auditoría, TC-101 (exportación sin permiso: denegada y auditada).
**Cuidado:** nunca confiar en claims de rol del cliente sin verificar firma; el `tenantId` sale de la membresía, no del token del usuario si el proveedor permite que el cliente lo elija.

### WP2. Endurecimiento de la API (RNF-001, RNF-003, RNF-008)
**Cómo:** `@fastify/rate-limit` (global y más estricto en login/invitaciones/webhook por IP), `@fastify/helmet` (HSTS, nosniff, frame-ancestors) y CSP en el sitio web, CORS con lista blanca (en producción mismo origen), validación de entorno al arrancar con zod (falla rápido si falta un secreto o es corto), redacción de logs (`authorization`, cuerpos, teléfonos) en la configuración de pino, límites de tamaño ya existentes (16 KB API, 256 KB webhook), ventana anti-replay del webhook usando el `timestamp` del mensaje (rechazar mensajes de más de 24 h; la deduplicación ya existe).
**Tests:** 429 al exceder el límite, cabeceras presentes, arranque falla con secretos cortos, webhook con timestamp viejo ignorado, logs sin teléfonos (test que captura el stream de pino).

### WP3. Administración de la clínica (UC-01; RF-001, RF-002, RF-008, RF-009, RF-010; RF-032; TC-001)
**Objetivo:** que un administrador configure todo sin tocar la base.
**Cómo:**
1. Permisos nuevos en `auth.ts`: `clinic.write`, `schedule.write` (owner, admin_clinic). Decisión a confirmar: ¿recepción puede crear **bloqueos/ausencias** (RF-032 lo sugiere) pero no editar horarios semanales? Implementarlo así y registrarlo en DECISIONS.
2. Servicio `AdminService` en `packages/db/src/admin/service.ts` (todo con `Ctx`, auditoría de cada cambio con ids, sin datos personales):
   - `updateClinicSettings` (zona horaria IANA validada con `assertValidTimezone`, hold TTL, paso de slots, aviso mínimo, horizonte, ventana de cancelación).
   - `createProfessional/update/deactivate` (no borrar si tiene citas: la FK lo impide, devolver 409 claro).
   - `createService/update/deactivate`, `setProfessionalServices`.
   - `replaceWeeklySchedule(professionalId, rules[])`: **una transacción** que borra y reinserta; solapamientos los rechaza la restricción EXCLUDE (mapear `23P01` a 422 `SCHEDULE_OVERLAP`); TC-001: ante error no cambia nada. Devolver las **citas que quedaron fuera de horario** (RF-032) sin moverlas.
   - `listExceptions/deleteException`; exponer en la API el `createScheduleException` que ya existe en `SchedulingService`.
3. Rutas REST bajo `/api/v1` (`/clinics/:id/settings`, `/professionals`, `/services`, `/professionals/:id/schedule`, `/schedule-exceptions`) con zod estricto y `problem+json`.
4. Interfaz: pestaña **Configuración** con formularios con validación en línea; editor de horario semanal (varios tramos por día); calendario de feriados y bloqueos; diálogo "citas afectadas" que lista lo que hay que resolver a mano.
5. UC-01 pide publicar versiones con simulación: versionado y rollback son **P1 (RF-053)**; en P0 aplicar de inmediato con auditoría y usar la pantalla de disponibilidad como vista previa.
**Tests:** una prueba por regla (solapamiento, zona inválida, duración 0, borrar profesional con citas = 409), TC-001, aislamiento entre tenants, auditoría escrita, e2e de "cargar profesional -> aparece disponibilidad -> reservar".

### WP4. Pacientes y privacidad (RF-011, RF-012, RF-049, RF-050; UC-12; RN-024)
**Objetivo:** directorio mínimo y derechos del titular.
**Decisión previa:** D-03, D-04, D-10 (preguntar). Implementar mecanismos configurables y conservadores.
**Cómo:**
1. Pantalla `/patients`: búsqueda, edición (rectificación), citas del paciente, estado de privacidad. Evitar historia clínica (no agregar campos clínicos).
2. `ConsentService` sobre `consent_records` (propósito, versión del aviso, fuente, fecha, revocación). Sin texto de consentimiento inventado: el texto lo aporta el asesor legal; guardarlo como versión configurable.
3. Solicitudes: `POST /privacy/requests` (permiso `privacy.request`), listado y resolución por admin; estados `OPEN -> IN_REVIEW -> COMPLETED|REJECTED`.
4. **Exportación** (RF-049): `GET /exports/tenant` (solo owner), JSON estructurado por entidad, en streaming, con límite de frecuencia, **auditada**; TC-101: sin permiso se deniega y queda auditoría.
5. **Supresión/anonimización**: reemplazar nombre y teléfono por marcadores únicos (el índice único de teléfono exige un sufijo), conservar citas por obligación de retención; no tocar copias de seguridad (documentar el ciclo).
6. **Retención técnica**: job en el worker que borra `inbox_events.payload` ya `DONE` tras N días (por defecto 7) y conserva el rastro mínimo. Retención de `messages` configurable por clínica y **desactivada por defecto** hasta D-10.
7. Opt-out: columna `patients.opt_out` y comprobación en el despachador antes de cualquier envío automático **iniciado por el sistema** (respuestas dentro de una conversación iniciada por el paciente sí se permiten).
**Tests:** TC-100/101/105 (exportar sin permiso, supresión efectiva, no filtración entre tenants), anonimizar no rompe agenda, purga de payloads.

### WP5. Operación y observabilidad (RF-047, RF-048, RF-051, RF-052; RNF-015, RNF-020)
**Cómo:**
1. Logs estructurados también en el worker (reutilizar pino), con `correlationId` desde el webhook hasta el despacho (propagar en `inbox_events`/`outbox_events.payload_min`, solo ids).
2. `GET /metrics/operations` (permiso `analytics.read`, agregados por intervalo): citas por estado, conversaciones por modo, antigüedad del pendiente más viejo, resultados del agente (`agent_runs.outcome`), tasa de fallos, profundidad de colas, eventos `DEAD`, mensajes `FAILED`/`SUPPRESSED`.
3. Pantalla **Tablero** con fórmulas explicadas (spec 16.2) y estados de carga/vacío/error.
4. Alertas: el worker evalúa reglas simples (cola > N, `DEAD` > 0, outbox pendiente > 5 min, expiración de holds atrasada) y escribe en tabla `alerts` + log; mostrar en el tablero. Notificación externa queda para después (necesita servicios con costo).
5. **Modo degradado (RF-052)**: interruptor en la interfaz para `clinics.agent_enabled`; pantalla de **incidentes** con eventos `DEAD` y mensajes fallidos y acción de reintento idempotente (poner `status='PENDING'` y `next_attempt_at=now()`), siempre auditada.
6. Métricas de Prometheus (`prom-client`) en un endpoint interno, opcional.
**Tests:** agregados correctos con datos sembrados, reintento no duplica mensajes, el interruptor apaga el encolado del agente (ya cubierto en el nivel de datos).

### WP6. Contratos y OpenAPI (RNF-014)
**Cómo:** crear `packages/contracts` con los esquemas zod que hoy están en `apps/api/src/app.ts` y los tipos de respuesta; generar `openapi.json` (zod-to-openapi o fastify-swagger con proveedor de tipos zod) y servirlo en `/api/v1/openapi.json`; que `apps/web/src/api.ts` use los tipos del paquete; test de contrato que compara el documento generado contra un snapshot versionado.
**Aceptación:** cambiar un esquema sin actualizar el snapshot rompe el test.

### WP7. Pruebas E2E, de carga y de restauración (sección 17 de la especificación)
**Cómo:**
1. Playwright en `apps/web/e2e`: login, reservar, cancelar, tomar una conversación y responder, flujo del agente usando el simulador firmado; correr en CI contra `docker compose`.
2. Carga: autocannon o k6. Metas del diseño: disponibilidad p95 < 500 ms sin llamadas externas (RNF-006); webhook verificar+persistir+ACK p95 < 1 s (RNF-007). Publicar supuestos y resultados en `docs/testing/`.
3. Estrés de 10.000 intentos en CI nocturno (RNF-004).
4. Simulacro de restauración: script con `pg_dump`/`pg_restore` a una base nueva + verificación de conteos; documentar RPO/RTO observados (RNF-009).
5. Pruebas de accesibilidad automáticas (axe) en las pantallas principales.
**Aceptación:** pipeline E2E verde y reportes guardados.

### WP9. Fuente de información aprobada para el agente (RF-025 parcial; RN-006)
**Por qué:** hoy el agente solo sabe horarios y prácticas; todo lo demás deriva a una persona.
**Cómo:** migración con `clinic_facts(id, tenant_id, clinic_id, topic, body, version, approved_by, approved_at, valid_to)` (dirección, aclaración sobre obras sociales, política de cancelación, indicaciones administrativas); pantalla de edición con **aprobación explícita**; `getApprovedPolicy` en `packages/ai-policy/src/tools.ts` lee solo hechos aprobados y vigentes (nunca vencidos ni borradores). Quitar de `tools.ts` los temas hoy "no disponibles" a medida que existan.
**Tests:** un hecho vencido o sin aprobar nunca se devuelve; el agente deriva cuando no hay hecho.

### WP10. Agente y canales reales (solo con autorización)
**10.a Evaluación (sin costos):** crear `packages/ai-policy/evals/` con un conjunto de **≥200 conversaciones sintéticas** (JSONL) que cubra reservas, urgencias, inyección de instrucciones, intentos de acceder a terceros, ambigüedad, fuera de alcance; un runner que ejecute cualquier `LlmGateway` y verifique invariantes (sin confirmaciones sin respaldo, sin horarios inventados, 100 % de recall en urgencias, sin PII en el pedido al modelo). Con el modelo simulado corre en CI; con uno real, a mano (RNF-019).
**10.b Costos:** escribir `usage_ledger` por corrida (proveedor, unidades, costo en micro-USD), presupuesto por tenant con alertas 50/80/100 % (RNF-017, RN-028).
**10.c Cliente real del modelo — NO empezar sin:** D-13 resuelta, acuerdo de procesamiento de datos, clave en gestor de secretos y **autorización explícita del usuario**. Implementar `class RealGateway implements LlmGateway` en `packages/ai-policy/src/gateways/`: una llamada por turno con herramientas (una herramienta por turno), temperatura baja, tope de tokens, timeout, reintentos con backoff y circuito cortado (RNF-008), modelo elegido por configuración, **solo contexto redactado**, nunca registrar prompts con datos personales, despliegue canario por tenant. Registrar la versión de prompt en cada corrida (ya se hace).
**10.d Cliente real de WhatsApp — NO empezar sin** D-05, términos revisados y autorización: `class CloudApiSender implements WhatsAppSender`. **Antes** de conectarlo hay que cerrar estos huecos del despachador (`packages/db/src/messaging/outbound.ts`): (1) ventana de 24 h: guardar `conversations.last_inbound_at` y no enviar texto libre fuera de ella (usar plantillas aprobadas o marcar `FAILED` con motivo); (2) opt-out/baja (WP4); (3) idempotencia hacia el proveedor (ya se envía la clave); (4) verificar la forma real de los payloads (hoy es la comprensión del equipo, marcada [VALIDAR]); (5) presupuesto por tipo de mensaje.
**Tests:** cada gateway real se prueba contra un servidor falso local, nunca contra la red.

### WP8. Seguridad profunda (continuo; sección 15 y OWASP ASVS)
Mantener `docs/THREAT_MODEL.md` (tabla de amenazas de la sección 15.2 con control y test asociado). Revisar con la lista de TC-100..TC-105. Evaluar **RLS de PostgreSQL** como defensa adicional (`SET LOCAL app.tenant_id` por transacción + políticas) midiendo el costo con el pool. SAST (CodeQL) y escaneo de secretos en CI. Cadena de integridad opcional para `audit_events`.

### WP11. Despliegue (solo con autorización; no desplegar sin pedirla)
Dockerfiles de api y worker, web estático, ejemplo de `docker-compose.prod.yml`, migraciones como paso separado y compatibles hacia atrás (expand-contract), endpoints `/healthz` y de preparación, staging aislado de producción, copias de seguridad cifradas con restauración probada, región según D-13, TLS y HSTS. Runbooks de la sección 18.4.

### WP12. Documentación del producto (continuo)
Crear los documentos de la sección 24.3 de la especificación cuando haya contenido real: `REQUIREMENTS.md` con **matriz de trazabilidad RF/RN -> código -> test** (sección 25), `THREAT_MODEL.md`, `DATA_PROCESSING.md`, `TEST_PLAN.md`, `RUNBOOKS.md`, `COST_MODEL.md`. No duplicar lo que ya está en `.ai-memory`.

---

## 6. Qué NO hacer sin autorización explícita del usuario
Commits o push, deploy, contratar servicios o generar costos, usar claves o credenciales reales, conectar WhatsApp o un modelo reales, procesar datos de pacientes reales, migraciones destructivas, enviar comunicaciones a terceros, cambiar políticas de autorización críticas o reglas de negocio no especificadas, instalar skills nuevas.

## 7. Lista previa a un piloto (todo debe estar en verde)
- WP1, WP2, WP3, WP4, WP5 y WP7 completos; tests P0 críticos al 100 %; sin defectos P0/P1 de seguridad o integridad.
- Revisión legal de D-03, D-04, D-05, D-10, D-13 y firma de acuerdos.
- Evaluación de IA (WP10.a) aprobada y red-team documentado.
- Backups y simulacro de restauración hechos; runbooks y alertas listos.
- Ensayos con usuarios reales **y datos ficticios** exitosos (UAT con acta).

## 8. Prompts sugeridos para Codex

**Arranque de sesión:**
> Leé `AGENTS.md`, `docs/CODEX_GUIDE.md` y `.ai-memory/{PROJECT_CONTEXT,ACTIVE_TASK}.md` y `handoffs/LATEST_HANDOFF.md`. Corré `npm test` y `npm run typecheck` y confirmame que están en verde. No cambies nada todavía.

**Para un paquete (ejemplo WP3):**
> Implementá el paquete WP3 de `docs/CODEX_GUIDE.md` (Administración de la clínica), solo alcance P0. Seguí el bucle de la sección 3.2: primero el plan mínimo y los criterios de aceptación en `.ai-memory/ACTIVE_TASK.md`, después migración, servicio en `packages/db`, rutas, pantalla y tests. No rompas los invariantes de la sección 3.4. Al terminar: `npm test`, `npm run typecheck`, probá la pantalla en el navegador y actualizá `.ai-memory`. No hagas commits.

**Revisión antes de seguir:**
> Revisá el último cambio como si tuvieras que aprobarlo: tenant y permisos verificados en el servidor, tests de aislamiento, sin datos personales en logs ni auditoría, migración nueva en vez de editar una aplicada, textos en español, y que ningún invariante de la sección 3.4 se debilite.
