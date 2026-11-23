---
title: "TurnoFlow | Especificación integral de producto, negocio e ingeniería"
subtitle: "PRD · SRS · arquitectura · seguridad · implementación · QA · operación"
author: "Documento técnico de planificación"
date: "23 de noviembre de 2026"
lang: es-AR
---

# Control documental

| Campo | Valor |
|---|---|
| Producto | TurnoFlow — plataforma de automatización administrativa para clínicas odontológicas y centros ambulatorios |
| Versión | 1.0 — propuesta de referencia para implementación |
| Estado | Diseño propuesto, **no aprobado comercial ni legalmente** |
| Mercado inicial propuesto | Clínicas odontológicas argentinas de 3 a 10 profesionales |
| Enfoque | Bootstrap, SaaS B2B multi-tenant, IA supervisada |
| Horizonte | MVP, primeras ventas, expansión por módulos |
| Destinatarios | Fundador, Product Manager, diseñadores, desarrollo, QA, seguridad, asesoría legal |

> **Convenciones de trazabilidad**: **[BASE]** corresponde a la propuesta del PDF original de TurnoFlow; **[PROPUESTA]** corresponde al diseño ampliado de este informe; **[VALIDAR]** significa que aún requiere evidencia comercial, legal o técnica. No confundir hipótesis ni escenarios financieros con hechos verificados.

# 1. Resumen ejecutivo

## 1.1 Problema

En clínicas pequeñas y medianas, las consultas por WhatsApp, las agendas distribuidas, los requisitos de cobertura, las cancelaciones y las tareas de recepción generan demoras, errores y posibles oportunidades comerciales perdidas. **[BASE]** El documento original sostiene cifras de preferencia por WhatsApp, fuga de pacientes y ausentismo, pero no aporta una muestra o fuente verificable: deben tratarse como hipótesis de investigación, **no como estadísticas demostradas**.

## 1.2 Propuesta de valor

**TurnoFlow** será una plataforma administrativa que atienda consultas no clínicas, gestione reservas y cancelaciones, coordine listas de espera, valide reglas configuradas por la clínica y permita intervención humana. Su propuesta diferenciadora futura será **recuperación verificable de turnos e ingresos potenciales**, no solo responder mensajes con un modelo conversacional. **[PROPUESTA]**

**Promesa comercial tentativa:** «Menos turnos perdidos. Más tiempo para atender». Evitar «cero errores», «reemplazamos al personal» o promesas de ingresos no medidos.

## 1.3 Alcance estratégico

- **ICP inicial:** clínica odontológica privada argentina con entre 3 y 10 profesionales, al menos un canal relevante de WhatsApp y persona responsable de recepción. **[PROPUESTA/VALIDAR]**
- **Comprador:** dueño/a o administrador/a; **usuarios internos:** recepcionistas, coordinadores y profesionales con permisos limitados.
- **Usuario externo:** paciente que conversa por canal autorizado.
- **MVP:** atención por mensajes, disponibilidad, reserva, cancelación, recordatorios, lista de espera simple, panel humano y métricas operativas.
- **Posterior:** reglas de coberturas avanzadas, señas, reactivación con consentimiento, analítica atribuible, sincronizaciones específicas, optimización predictiva.
- **Exclusión permanente salvo proyecto clínico independiente:** diagnóstico, triage médico autónomo, recomendaciones terapéuticas generadas, historia clínica y decisiones de cobertura no verificadas.

## 1.4 Diferencia frente al documento base

**[BASE]** TurnoFlow original define atención de texto y audio, verificación de obras sociales, reserva y cobro de señas, lista de espera, panel humano; propone US$350 de setup, US$220/mes, US$1.000 de inversión inicial y 27 clientes a seis meses. **[PROPUESTA]** Este informe refactoriza el alcance en fases, reemplaza supuestos de riesgo excesivo por criterios de aceptación y agrega controles de seguridad, observabilidad, aislamiento por cliente, sincronización, casos límite y validación comercial.

# 2. Objetivos, métricas e hipótesis

## 2.1 Objetivos SMART propuestos

| ID | Objetivo | Meta de validación | Plazo orientativo |
|---|---|---|---|
| OBJ-01 | Entender el problema | ≥15 entrevistas con responsables de clínicas, ≥5 observaciones del proceso actual | semanas 1–3 |
| OBJ-02 | Comprobar disposición a pagar | ≥3 compromisos de piloto pago, precio y alcance por escrito | antes de desarrollo extenso |
| OBJ-03 | Operar con seguridad | 0 reservas confirmadas duplicadas en pruebas de concurrencia; incidentes críticos abiertos = 0 | antes de piloto real |
| OBJ-04 | Demostrar valor | medir conversión contacto→turno, respuesta, cancelaciones, recuperos, errores y coste por clínica | piloto de 30–60 días |
| OBJ-05 | Viabilidad de soporte | onboarding repetible, documentación y operación no dependiente exclusivamente del fundador | antes de 10 clientes |
| OBJ-06 | Viabilidad comercial | renovar ≥80% de clínicas piloto al terminar el período, como umbral exploratorio | después del piloto |

Las metas son **criterios de decisión propuestos** y deberán renegociarse a partir de datos reales.

## 2.2 KPIs y definición exacta

| KPI | Fórmula / definición | Riesgo de interpretación |
|---|---|---|
| MRR | suma de abonos mensuales recurrentes activos, sin setup ni impuestos | no es utilidad |
| Activación de clínica | canal enlazado + 1 profesional + agenda + reglas + caso de prueba exitoso | no equivale a valor comercial |
| Tiempo de primera respuesta | p50, p95 desde recepción del webhook hasta mensaje enviado/entregado, reportando ambas marcas | latencia ajena de Meta |
| Conversión contacto→reserva | conversaciones elegibles con reserva confirmada / conversaciones elegibles | corregir por consultas no destinadas a reservar |
| No-show | citas marcadas «no asistió» / citas programadas elegibles | variación por clínica y especialidad |
| Ocupación | minutos reservados efectivos / minutos disponibles configurados | excluir vacaciones y cierres |
| Turno recuperado | cita cancelada reasignada antes de su inicio, con evento verificable | no siempre implica ingreso incremental |
| Ahorro administrativo | tiempo observado previo − posterior, ajustado por volumen | requiere medición, no inferencia del LLM |
| Automatización segura | conversaciones resueltas sin intervención humana y sin reclamación/error conocido | no optimizar solo por tasa de autonomía |
| Error de agenda | acciones fallidas/duplicadas, discrepancias o reservas inválidas por 1.000 intentos | métrica crítica |
| Costo variable/clínica | Meta + LLM + audio + infraestructura variable + proveedores + pagos asociados | usar facturas reales |
| Retención | clientes al cierre que estaban activos al inicio / clientes activos al inicio, excluyendo nuevas altas | evitar muestras pequeñas |

## 2.3 Hipótesis a invalidar temprano

H1: suficientes clínicas sienten un problema urgente; H2: un canal IA está permitido y es comercialmente viable bajo las condiciones de Meta; H3: el proceso administrativo puede automatizarse sin acceder a datos clínicos; H4: conectores reales de agenda son robustos; H5: la clínica pagaría un abono que cubra soporte e implementación; H6: hay una brecha competitiva comprobable; H7: adquisición comercial y onboarding pueden estandarizarse.

# 3. Mercado, competidores y estrategia

## 3.1 Segmentación

- **Segmento A — odontología (primero):** varias agendas, tratamientos de distinta duración, recepción saturada y presupuestos pendientes. **[PROPUESTA]**
- Segmento B — kinesiología: ciclos de sesiones y recurrencia, con complejidades propias.
- Segmento C — centros polimédicos: más coberturas, profesionales y validaciones; posponer hasta consolidar arquitectura.

## 3.2 Alternativas reales del cliente

Personal administrativo, WhatsApp Business manual, Google Calendar, planillas, software local, AgendaPro, Doctoralia, Órbita, Dentia, XIAgenda y sistemas construidos a medida. **[VALIDAR]** Solicitar demos y propuestas comerciales; no afirmar superioridad ni ausencia de una función sin probarla.

## 3.3 Posicionamiento propuesto

1. **Fiabilidad operacional y trazabilidad:** reserva real, datos actualizados, correcciones auditables.
2. **Configuración por clínica sin código:** reglas versionadas y testeables.
3. **Medición económica verificable:** citas recuperadas, costo y tiempos, no métricas inventadas.
4. **Integración sin migración obligatoria:** conectores probados y límites transparentes.
5. **Privacidad y control humano:** canal de escalamiento accesible, consentimiento donde aplique y segregación de datos.

## 3.4 Go-to-market

**Fase 0:** entrevistas y observación del proceso; mapear competencia; definir tickets y entrevistas con asesor legal. **Fase 1:** pilotos con contrato, alcance limitado, configuración acompañada, objetivo de medición claro. **Fase 2:** casos de estudio solo con autorización y cifras auditables. **Fase 3:** alianzas con consultores odontológicos, implementadores de software y asociaciones, sin acceso impropio a datos personales.

**Mensajes de venta permitidos:** tiempo de respuesta, horas administrativas observadas y turnos efectivos. **No permitidos sin prueba:** «25% menos ausencias», «recupera X dólares garantizados».

# 4. Stakeholders y actores

| Actor | Responsabilidad / necesidad |
|---|---|
| Dueño/administrador clínica | contratar, definir reglas, leer indicadores, aprobar integraciones |
| Responsable de recepción | supervisar bandeja, confirmar excepciones, corregir reservas |
| Profesional | ver su agenda y disponibilidad autorizada, bloquear horarios propios según permisos |
| Paciente | consultar, solicitar, confirmar o cancelar turnos por canal seguro |
| Operador soporte TurnoFlow | resolver incidentes sin acceder por defecto a información identificable |
| Administrador plataforma | facturación SaaS, salud operativa, tenants, licencias; no contenido de pacientes por defecto |
| Proveedor WhatsApp | transporte y reglas de mensajería, plantillas y tarifas |
| Proveedor calendario | agenda externa; sincronización potencialmente eventual |
| Pasarela de pago | crea y confirma órdenes/pagos; fuente autorizada de estado económico |
| Asesor legal y seguridad | validar obligaciones y tratamiento de datos |

# 5. Alcance, límites y prioridades

## 5.1 MVP P0 (necesario para piloto seguro)

Tenant y usuarios, roles, clínica/profesionales/servicios/duraciones, disponibilidades, bloqueos, WhatsApp oficial (si el caso es permitido), bandeja, identificación mínima del paciente, comprensión de intención, disponibilidad determinista, reserva y cancelación, confirmación verificable, handoff humano, recordatorio habilitado, logs/auditoría, reporting mínimo, monitoreo, privacidad y controles básicos de costos.

## 5.2 P1 (después de pilotos)

Lista de espera automatizada con consentimiento, reprogramación guiada, coberturas y planes con versiones/vigencias, conectores calendarios, mensajes de audio, pagos de seña, presupuestos administrativos y analítica económica.

## 5.3 P2 (escala)

Optimización de agenda, sugerencias de recupero de presupuestos pendientes, reglas avanzadas, modelos predictivos calibrados y auditados, conectores de software de gestión, multisitio, localización por país, SSO empresarial.

## 5.4 Fuera de alcance

Historia clínica, recomendaciones médicas individualizadas, recetas, diagnóstico, diagnóstico de urgencias, verificación automática contra padrones de obras sociales sin acuerdo/infraestructura autorizada, facturación fiscal sin integración certificada, marketing masivo sin permisos, pagos guardando números de tarjeta, scraping de sistemas sin licencia.

# 6. Catálogo de requisitos funcionales (RF)

**Convención:** P0 obligatorio MVP; P1 posterior; P2 largo plazo. Cada RF describe resultado observable y criterios mínimos de aceptación. El detalle de errores se amplía en UC y pruebas.

## 6.1 Organización, identidades y permisos

| ID | Pri | Requisito y aceptación mínima |
|---|---|---|
| RF-001 | P0 | Alta de organización/tenant. Identificador único, estado de activación y zona horaria; alta auditada. |
| RF-002 | P0 | Configuración de clínicas/sedes, horarios, feriados, contacto y políticas de cancelación; validación de superposiciones. |
| RF-003 | P0 | Invitación y revocación de usuarios; invitaciones de un uso con expiración; revocación inmediata de sesiones. |
| RF-004 | P0 | RBAC: owner, admin_clinic, receptionist, practitioner, support_limited; denegar por defecto y validar en backend. |
| RF-005 | P0 | MFA para propietarios/administradores y personal privilegiado; bloqueo/rate limiting de accesos. |
| RF-006 | P0 | Registro inmutable de operaciones sensibles (cambio de reglas, accesos elevados, reservas, cancelaciones). |
| RF-007 | P1 | Dos o más sedes por organización, límites por plan y supervisión centralizada. |

## 6.2 Catálogos, pacientes y reglas

| ID | Pri | Requisito y aceptación mínima |
|---|---|---|
| RF-008 | P0 | ABM profesional con especialidad, sede, capacidad, horario y estado; evitar borrado si tiene citas vinculadas. |
| RF-009 | P0 | ABM servicios/prácticas administrativas, duración, buffers, requisitos y profesionales habilitados. |
| RF-010 | P0 | Horario semanal, excepciones, feriados, ausencias y bloqueos manuales; sin crear slots fuera de reglas. |
| RF-011 | P0 | Datos mínimos de contacto de paciente, normalización de teléfono y deduplicación conservadora. |
| RF-012 | P0 | Información y opciones de privacidad según tratamiento; registrar fuente y fecha de aceptación cuando corresponda. |
| RF-013 | P1 | Matriz versionada de obra social/plan/profesional/servicio/coseguro/vigencia, aprobada por administrador. |
| RF-014 | P1 | Si falta cobertura confiable o la regla está vencida, pasar a recepción; nunca inferir aceptación. |
| RF-015 | P1 | Historial administrativo de presupuestos y estado (pendiente, aprobado, vencido), sin historia clínica. |

## 6.3 Mensajería y agente

| ID | Pri | Requisito y aceptación mínima |
|---|---|---|
| RF-016 | P0 | Recibir webhooks oficiales; verificar autenticidad; deduplicar evento; responder dentro del plazo del proveedor. |
| RF-017 | P0 | Guardar identificador externo, origen, estado y marca temporal; reintentos no duplican mensajes. |
| RF-018 | P0 | Detectar intención administrativa: información, reservar, cancelar, reprogramar, hablar con humano. |
| RF-019 | P0 | Respuestas basadas en datos aprobados y plantillas de seguridad; nunca generar disponibilidad ni cobertura inventada. |
| RF-020 | P0 | Bandeja centralizada con estado: bot, esperando_humano, humano, cerrada; tomar/soltar conversación. |
| RF-021 | P0 | Escalar por incertidumbre, error de herramienta, urgencia aparente, petición humana o regla no disponible. |
| RF-022 | P0 | Suspender envíos automáticos al tomar una conversación un humano y evitar respuestas simultáneas. |
| RF-023 | P0 | Respetar ventana de atención y plantillas aprobadas según política vigente del proveedor; medir costos. |
| RF-024 | P1 | Transcribir audios si existe base legítima; privacidad, duración y manejo de confianza/errores. |
| RF-025 | P1 | Configuración de tono, respuestas institucionales y horarios por clínica, con vista previa y aprobación. |
| RF-026 | P1 | Estadísticas de volumen, escalamiento, latencias, fallos y consumos por canal y tenant. |
| RF-027 | P2 | Multicanal (sitio web, teléfono, otros) sin mezclar identidades sin consentimiento/verificación. |

## 6.4 Agenda y transacciones

| ID | Pri | Requisito y aceptación mínima |
|---|---|---|
| RF-028 | P0 | Consultar slots usando reglas vigentes y zona horaria; backend determina qué horarios son reservables. |
| RF-029 | P0 | Bloquear temporalmente un slot con expiración; intentos concurrentes no duplican hold activo. |
| RF-030 | P0 | Confirmar cita con transacción única e idempotencia, sin superposición para recurso/profesional. |
| RF-031 | P0 | Cancelar cita según política, liberar capacidad y auditar actor y motivo. |
| RF-032 | P0 | Modificar/bloquear disponibilidad; detectar citas afectadas y notificar al operador, sin reprogramar sin autorización. |
| RF-033 | P0 | Gestionar cita con estados definidos, transiciones válidas y conservación de historial. |
| RF-034 | P1 | Reprogramación atómica o compensada: reservar nuevo horario antes de liberar el anterior cuando corresponda. |
| RF-035 | P1 | Lista de espera con orden de prioridad transparente, elegibilidad y vencimiento de oferta. |
| RF-036 | P1 | Recordatorios programados, políticas de opt-out y cancelación de tareas tras cambios de cita. |
| RF-037 | P1 | Google Calendar: sincronización con identificadores externos, webhooks, reconciliación y manejo de conflictos. |
| RF-038 | P1 | Administrar múltiples recursos (sillón/sala/equipo) y disponibilidad conjunta. |

## 6.5 Pagos y administración comercial

| ID | Pri | Requisito y aceptación mínima |
|---|---|---|
| RF-039 | P1 | Configurar necesidad de seña por servicio con monto y vigencia aprobados. |
| RF-040 | P1 | Generar orden de pago vinculada a hold/cita; URL de proveedor, sin procesar tarjetas directamente. |
| RF-041 | P1 | Verificar notificación firmada del proveedor, consultar estado canónico y procesar idempotentemente. |
| RF-042 | P1 | Confirmar cita solamente con pago aprobado y reserva válida; manejar pago tardío con revisión/reembolso. |
| RF-043 | P1 | Reconciliación diaria de pagos, pendientes, devoluciones e incidentes. |
| RF-044 | P1 | Configurar plan SaaS, límites, facturación a clínicas y estado de cuenta (proveedor fiscal según jurisdicción). |
| RF-045 | P2 | Flujos de seguimiento de presupuesto administrativo con autorización y frecuencia limitada. |
| RF-046 | P2 | Reporte de ingresos atribuibles con supuestos, límites y separación entre reservas/cobros. |

## 6.6 Supervisión, operación y datos

| ID | Pri | Requisito y aceptación mínima |
|---|---|---|
| RF-047 | P0 | Dashboard de citas, conversaciones, errores, disponibilidad y estado de integraciones. |
| RF-048 | P0 | Alertas operativas ante integraciones caídas, acumulación de cola, fallos de reservas y cambios críticos. |
| RF-049 | P0 | Exportación autorizada de datos administrativos del tenant en formato estructurado. |
| RF-050 | P0 | Solicitudes de acceso, rectificación y supresión conforme obligación legal aplicable, retenciones y excepciones. |
| RF-051 | P0 | Job de expiración de holds, reintentos, reconciliación e identificación de mensajes huérfanos. |
| RF-052 | P0 | Panel de incidentes y modo degradado (agente apagado, derivación humana y no confirmación automática). |
| RF-053 | P1 | Registro de versiones de reglas y rollback auditado a configuración previa. |
| RF-054 | P1 | Informe mensual de impacto con métricas trazables y período comparable. |
| RF-055 | P2 | Experimentos de experiencia/adquisición con consentimiento y sin experimentar con seguridad de turnos. |

# 7. Requisitos no funcionales (RNF)

Se definen **objetivos de diseño propuestos**, no SLA contractuales prometidos. Deben probarse bajo carga real antes de publicarlos.

| ID | Dimensión | Requisito medible / verificación |
|---|---|---|
| RNF-001 | Seguridad | HTTPS/TLS vigente; HSTS; cookies seguras HttpOnly SameSite; CSP evaluada; secretos fuera de repositorios. |
| RNF-002 | Aislamiento | Toda consulta por tenant; tests automáticos con 2+ tenants demuestran ausencia de lectura/escritura cruzada. |
| RNF-003 | Autorización | 100% de endpoints sensibles verifica permisos y tenant en backend; pruebas IDOR/BOLA. |
| RNF-004 | Integridad | 0 reservas confirmadas incompatibles en 10.000 intentos concurrentes simulados bajo la topología de prueba. |
| RNF-005 | Disponibilidad | Objetivo interno inicial ≥99,5% del componente propio por mes, excluyendo terceros; medir por separado. |
| RNF-006 | Rendimiento | API de lectura de disponibilidad p95 <500 ms en test controlado sin llamadas externas; publicar supuestos. |
| RNF-007 | Mensajería | webhook verifica, persiste/encola y responde p95 <1 s en carga de referencia; responder al usuario puede tardar más. |
| RNF-008 | Resiliencia | Reintentos con backoff, DLQ, idempotencia, timeouts y circuit breaker; fallos externos no generan confirmaciones falsas. |
| RNF-009 | Recuperación | RPO objetivo ≤24 h y RTO ≤8 h para MVP; backups automáticos y restauración probada trimestralmente. |
| RNF-010 | Auditoría | Toda acción sensible incluye tenant, actor, recurso, motivo, origen, timestamp y correlation_id. |
| RNF-011 | Privacidad | Minimización y retención configurable con revisión legal; datos personales excluidos por defecto de logs, analítica y trazas LLM. |
| RNF-012 | Accesibilidad | WCAG 2.2 AA como objetivo de interfaz; test teclado, contraste, lectores y formularios. |
| RNF-013 | Localización | Idioma es-AR MVP; fechas almacenadas UTC, visualización por zona IANA de clínica, soportar DST en expansión. |
| RNF-014 | Mantenibilidad | Arquitectura modular; contratos OpenAPI; tests automatizados; ADR para decisiones relevantes; linter y revisión. |
| RNF-015 | Observabilidad | logs estructurados, métricas y trazas correlacionadas; alertas por tasas de error, latencia y costo. |
| RNF-016 | Escalabilidad | Workers horizontales sin asumir ejecución una sola vez; transacciones seguras al duplicar instancias. |
| RNF-017 | Costos | Presupuesto y límites por tenant, proveedor y tipo de mensaje; alertas 50/80/100% de presupuesto. |
| RNF-018 | Ciclo de datos | política de exportación, portabilidad, retención y borrado comprobables; backups sujetos a ciclo definido. |
| RNF-019 | Calidad IA | conjunto de evaluación con ≥200 conversaciones anonimizadas/sintéticas y pruebas de no-invención previo a piloto. |
| RNF-020 | Continuidad | modo manual accesible ante fallas de IA o canal; no pérdida silenciosa de tareas críticas. |
| RNF-021 | Legal | validación formal de rol responsable/encargado, transferencias internacionales, avisos, acuerdos y proveedores antes del piloto. |
| RNF-022 | Verificabilidad | cada RF/RNF crítico vinculado a tests y evidencia almacenada en CI y reportes QA. |

# 8. Reglas de negocio (RN)

## 8.1 Identidad, reglas y disponibilidad

| ID | Regla |
|---|---|
| RN-001 | Una organización no puede leer ni modificar recursos de otra, aun con IDs conocidos. |
| RN-002 | Solo administradores autorizados publican cambios de reglas; cada cambio tiene versión y vigencia. |
| RN-003 | La duración reservada = duración práctica + buffers configurados, bajo disponibilidad de recursos necesarios. |
| RN-004 | Un servicio solo puede reservarse con profesional/sede/recurso habilitados. |
| RN-005 | Horarios fuera de atención, feriados, ausencias, bloqueos y citas vigentes no son reservables. |
| RN-006 | Si la regla de cobertura falta, está vencida o es contradictoria, se requiere confirmación humana. |
| RN-007 | La identificación por teléfono no autoriza por sí sola a revelar datos sensibles ni modificar citas de terceros. |
| RN-008 | La clínica define ventanas de reserva/cancelación y excepciones; defaults explícitos, nunca supuestos ocultos. |
| RN-009 | Todas las decisiones de agenda usan hora absoluta y zona horaria de sede; cambios DST verificados. |

## 8.2 Ciclo de reserva

| ID | Regla |
|---|---|
| RN-010 | Un mismo intervalo excluyente por profesional/recurso no admite dos citas activas incompatibles. |
| RN-011 | Los holds tienen TTL configurable (propuesta: 10 min) y no garantizan una agenda externa sin reserva externa equivalente. |
| RN-012 | Confirmación es idempotente por clave de operación y transición de estado. |
| RN-013 | No se confirma un turno solamente porque el LLM diga que fue confirmado. |
| RN-014 | Una cita cancelada conserva historial y no reaparece como confirmada por reintentos tardíos. |
| RN-015 | Reprogramación requiere nueva disponibilidad, y mantiene o compensa el estado previo ante fallos. |
| RN-016 | En sincronización conflictiva con calendario externo, el sistema suspende confirmación automática y crea incidencia. |
| RN-017 | En modo degradado, turnos nuevos quedan pendientes de revisión o se informa que no puede confirmarse. |
| RN-018 | Una oferta de lista de espera vence, y al aceptarla se revalida la disponibilidad en transacción. |

## 8.3 Pagos, mensajes y datos

| ID | Regla |
|---|---|
| RN-019 | Pago «aprobado» únicamente desde proveedor verificado/consulta canónica; nunca desde texto ni query de retorno del navegador. |
| RN-020 | Pago tardío tras caducidad del hold no reasigna automáticamente el horario; queda pendiente de revisión y compensación. |
| RN-021 | Toda salida automática a paciente respeta consentimiento, plantillas, ventanas y opt-out según norma aplicable. |
| RN-022 | Solicitud de humano desactiva agente hasta liberación explícita o política aprobada. |
| RN-023 | Emergencia aparente: mensaje fijo aprobado para acudir a servicios de urgencia y derivación humana; no diagnóstico automático. |
| RN-024 | Datos clínicos no se solicitan ni almacenan por diseño; contenido clínico incidental se minimiza y protege. |
| RN-025 | Recordatorio no puede enviarse para cita cancelada, reprogramada ni a destinatario cuya identidad sea dudosa. |
| RN-026 | Los indicadores de «ingresos recuperados» separan monto presupuestado, cobrado y atribución estimada. |
| RN-027 | Un cambio sensible exige actor autorizado, audit trail y, en operaciones de riesgo, confirmación. |
| RN-028 | El límite de uso por plan produce alertas y degradación controlada, nunca corte silencioso en medio de una transacción. |

# 9. Casos de uso (UC) con flujos y excepciones

## UC-01 — Configurar una clínica

**Actores:** owner/administrador. **Precondiciones:** tenant creado, identidad verificada, permisos suficientes. **Flujo:** (1) alta de sede; (2) zona horaria y horario de atención; (3) carga de profesionales; (4) prácticas y duración; (5) reglas básicas; (6) revisión de vista previa; (7) publicación versionada; (8) test de disponibilidad. **Resultado:** clínica activada para pruebas. **Excepciones:** configuración incompleta bloquea publicación; horarios solapados se rechazan; una actualización con citas existentes genera advertencias y plan de conciliación. **RF:** 001,002,004,008–010,053. **RN:** 002–005. **Test:** TC-001/002.

## UC-02 — Paciente pide un turno por WhatsApp

**Actores:** paciente, agente, agenda. **Precondiciones:** canal habilitado, reglas válidas. **Flujo:** (1) webhook verificado; (2) deduplicación; (3) reconocimiento de intención; (4) recolección mínima de profesional/práctica/fecha; (5) función `searchAvailability`; (6) ofrecimiento solo de slots reales; (7) paciente selecciona; (8) `createHold`; (9) confirmación según política; (10) `confirmAppointment`; (11) mensaje con identificador/canal seguro. **Resultado:** cita confirmada o caso en espera, nunca confirmación ficticia. **Alternativas:** sin disponibilidad => opciones permitidas; ambigüedad => aclaración; integración caída => handoff; paciente cambia de idea => liberar hold. **RF:** 016–023,028–030. **RN:** 003–013,017. **Test:** TC-010–018.

## UC-03 — Dos pacientes solicitan mismo horario

**Actores:** dos pacientes. **Flujo:** peticiones simultáneas; la primera reserva crea ocupación excluyente y la segunda recibe conflicto controlado; nueva consulta ofrece alternativas. **Resultado:** exactamente una reserva activa confirmable. **Excepción:** si proveedor externo admite conflicto, bloquear confirmación y conciliar. **RF:** 029–030,037. **RN:** 010–013,016. **Test:** TC-020–023.

## UC-04 — Recepcionista toma conversación

**Actores:** recepcionista, agente. **Flujo:** recepcionista pulsa «Tomar»; backend adquiere control de conversación; workers invalidan respuestas pendientes por versión del control; interfaz muestra estado humano; recepcionista responde; cierra o devuelve al agente. **Resultado:** nunca llegan mensajes automáticos de contenido simultáneo después del takeover. **Excepciones:** mensajes previamente entregados por proveedor no pueden retirarse; registrar y mostrar ese límite. **RF:** 020–022. **RN:** 022–023. **Test:** TC-030–032.

## UC-05 — Cancelar turno

**Actores:** paciente verificado / recepción. **Flujo:** identificar turno sin divulgar información sensible, confirmar autorización y política, cancelar en backend, auditar, actualizar integración, cancelar recordatorios y eventualmente iniciar lista de espera. **Resultado:** cita cancelada una sola vez. **Excepciones:** plazo vencido => derivar; reintento repetido => misma respuesta; falta de identidad => acceso por canal alternativo. **RF:** 031,035–037. **RN:** 007,014,018,025. **Test:** TC-040–044.

## UC-06 — Reprogramar turno

**Actores:** paciente verificado/recepción. **Flujo:** validar cita y política, listar nuevos horarios, bloquear nuevo slot, confirmar cambio transaccionalmente, sincronizar sistemas y notificar. **Resultado:** nueva cita vigente y previa liberada según regla. **Excepciones:** fallo externo => estado de sincronización pendiente con revisión; no perder la cita original antes de asegurar la nueva. **RF:** 034,037. **RN:** 014–017. **Test:** TC-045–049.

## UC-07 — Lista de espera ocupa cancelación

**Actores:** paciente en lista, worker. **Flujo:** cancelación libera slot, seleccionar elegibles con reglas explícitas, enviar oferta con vencimiento, paciente acepta y backend revalida/captura el slot. **Resultado:** reasignación verificable. **Excepciones:** múltiples aceptaciones => una gana; vencimiento => siguiente candidato; opt-out => no enviar. **RF:** 035–036. **RN:** 018,021. **Test:** TC-050–055.

## UC-08 — Registrar y confirmar seña (P1)

**Actores:** paciente, pasarela, worker. **Flujo:** calcular seña por regla aprobada, hold temporal, generar checkout con referencia interna, verificar notificación firmada, recuperar pago del proveedor, confirmar reserva si aún válida, emitir confirmación. **Excepciones:** pago rechazado, reintentos, pagos tardíos, webhook duplicado, montos diferentes, devolución y fallo de sincronización. **RF:** 039–043. **RN:** 019–020. **Test:** TC-060–069.

## UC-09 — Consultar cobertura (P1)

**Actores:** paciente, agente, backend. **Flujo:** identificar plan declarado; consultar matriz versionada; responder solo con hechos vigentes y condiciones; si no hay certeza, recepción. **Excepciones:** nombre ambiguo, plan obsoleto, coseguro faltante, validación online no autorizada. **Resultado:** respuesta administrativa respaldada, no validación de afiliación inventada. **RF:** 013–014,019. **RN:** 006. **Test:** TC-070–074.

## UC-10 — Gestionar aviso de urgencia aparente

**Actores:** paciente, agente, recepción. **Flujo:** detectar señales de posible urgencia (sin diagnosticar), interrumpir automatización de reservas, proporcionar mensaje institucional fijo de emergencia, elevar inmediatamente a humano y registrar evento minimizado. **Excepciones:** recepción desconectada => aviso alternativo explícito; no prometer monitoreo 24/7 por humano si no existe. **RF:** 021–022,052. **RN:** 023–024. **Test:** TC-080–084.

## UC-11 — Sincronizar agenda externa (P1)

**Actores:** conector, calendar, recepcionista. **Flujo:** OAuth y permisos mínimos, vincular calendario, lectura inicial, watch/webhooks o polling seguro, reconciliación periódica, deduplicación por external ID/etag y registro de conflictos. **Excepciones:** token expirado, canal de notificaciones vencido, API fuera de servicio, actualización simultánea. **Resultado:** estado de sincronización visible; nunca asumir consistencia fuerte externa. **RF:** 037. **RN:** 016–017. **Test:** TC-090–099.

## UC-12 — Solicitar exportación o supresión

**Actores:** paciente, clínica responsable, oficial autorizado. **Flujo:** verificar identidad, registrar solicitud, evaluar obligaciones legales, exportar/corregir/suprimir o justificar excepciones, propagar a proveedores donde sea aplicable y cerrar con evidencia. **Excepciones:** obligaciones de conservación y backups; aplicar calendario de retención y restricciones técnicas documentadas. **RF:** 049–050. **RN:** 024. **Test:** TC-100–105.

# 10. Arquitectura de referencia

## 10.1 Decisión principal: monolito modular + workers

**[PROPUESTA]** Evitar microservicios al comienzo. Un backend TypeScript con módulos de dominio y workers separados ofrece transacciones más sencillas y menor complejidad operativa. Crecer después mediante extracción controlada de módulos si hay evidencia de necesidad.

```text
                ┌──────────────────────────────┐
                │ Panel web React / Next.js    │
                │ Recepción, admin, reportes   │
                └─────────────┬────────────────┘
                              │ HTTPS
WhatsApp Cloud API ─── webhook│
Google Calendar ───── webhooks│
Mercado Pago (P1) ─── webhooks│
                              ▼
                ┌──────────────────────────────┐
                │ API / BFF (Node, TypeScript) │
                │ Auth, RBAC, tenant context    │
                │ Validación Zod/OpenAPI       │
                ├──────────────────────────────┤
                │ Módulos de dominio           │
                │ Clinic / Patient / Booking   │
                │ Rules / Conversation / Billing│
                │ Audit / Integrations         │
                └───────┬───────────┬──────────┘
                        │           │ outbox
                        ▼           ▼
                  PostgreSQL     Redis/BullMQ
                        ▲           │
                        │           ▼
                        └────── Worker(s) ──► APIs externas
                                     │
                                     └──► LLM mediante AI Gateway
                Observabilidad: logs, métricas, trazas, alertas
```

## 10.2 Stack recomendado

| Capa | Elección sugerida | Motivo / alternativa |
|---|---|---|
| Frontend | Next.js + TypeScript + Tailwind + componentes accesibles | experiencia en stack; React Router/Vite también válido |
| API | Node.js + NestJS o Fastify + TypeScript | estructura modular; Fastify liviano; elegir uno y documentar ADR |
| ORM/queries | Prisma + SQL puntual en operaciones críticas | migraciones/productividad; usar SQL nativo para exclusiones/transacciones |
| Datos | PostgreSQL administrado | ACID, índices, constraints, JSONB con límites |
| Trabajos | Redis + BullMQ | reintentos y timers; combinar con outbox transaccional |
| Archivos | Object storage cifrado y URLs temporales | datos minimizados; no guardar audios indefinidamente |
| Autenticación | proveedor gestionado con MFA y RBAC backend | simplifica identidad; validar claims y sesiones |
| IA | gateway adaptable a proveedores, salida estructurada, tool calling | controlar costo y cambios sin dependencia única |
| Observabilidad | OpenTelemetry + error tracking + métricas | trazabilidad sin filtrar PII |
| Infra | hosting región elegida tras análisis legal; staging separado | región y transferencias deben validarse |
| CI/CD | GitHub Actions, escáner dependencias, SAST, pruebas | despliegue con migraciones controladas |

## 10.3 Módulos y dependencias

- `identity`: usuarios, sesiones, permisos, claims y contexto de tenant.
- `organization`: sedes, profesionales, servicios, recursos y configuraciones.
- `scheduling`: disponibilidad, holds, citas, bloqueos y transacciones (fuente canónica interna).
- `coverage`: catálogos, versiones y reglas administrativas; P1.
- `messaging`: WhatsApp, inbox, mensajes, plantillas, estados y handoff.
- `agent`: orquestador de intenciones/herramientas con policy engine; **no escribe tablas directamente**.
- `payments`: referencias, pagos, conciliación, devolución; P1.
- `integrations`: proveedores con adapters y políticas de reintento.
- `analytics`: eventos métricos, reportes, definiciones y atribución.
- `privacy`: derechos, consentimientos, retención y auditoría.
- `platform`: planes, tenants, soporte, configuración y límites.

**Dependencia obligatoria:** agent → servicios de aplicación → dominio → repositorio; nunca agent → SQL directo. Workers ejecutan comandos idempotentes, no lógica duplicada.

# 11. Modelo de datos lógico

## 11.1 Entidades principales

| Tabla | Claves/campos esenciales | Restricciones |
|---|---|---|
| tenants | id, slug, status, region, created_at | slug único |
| users | id, external_auth_id, email, status | identidad única |
| memberships | tenant_id, user_id, role, status | unique(tenant_id,user_id) |
| clinics | id, tenant_id, timezone, name, status | FK tenant, timezone IANA |
| professionals | id, tenant_id, clinic_id, name, active | FK compuesta tenant |
| services | id, tenant_id, duration_min, buffer_min, active | duración >0 |
| professional_services | tenant_id, professional_id, service_id | unique compuesto |
| resources | id, tenant_id, clinic_id, resource_type | agenda multi-recurso P1 |
| schedules | tenant_id, professional_id, weekday, start_local, end_local | rangos válidos |
| schedule_exceptions | id, tenant_id, professional_id, starts_at, ends_at, type | starts<ends |
| patients | id, tenant_id, name, phone_e164, privacy_status | identificación mínima |
| patient_contacts | id, tenant_id, patient_id, channel, external_id | vínculo verificado |
| appointments | id, tenant_id, clinic_id, patient_id, professional_id, service_id, start_at, end_at, status, version | constraints de intervalos |
| appointment_resources | tenant_id, appointment_id, resource_id | control por recurso |
| booking_holds | id, tenant_id, slot_key, expires_at, status, token_hash | expiración y exclusión |
| conversations | id, tenant_id, patient_id_nullable, channel, mode, version | estado bot/human |
| messages | id, tenant_id, conversation_id, provider_message_id, direction, delivery_status | unique tenant+provider_msg |
| inbox_events | id, tenant_id_nullable, provider, event_id, payload_ref, received_at | unique provider+event |
| outbox_events | id, tenant_id, aggregate_id, type, payload_min, dispatched_at | reintentos seguros |
| audit_events | id, tenant_id, actor_id, action, object_ref, happened_at, correlation_id | escritura append-only |
| coverage_rules | id, tenant_id, clinic_id, plan_id, professional_id, service_id, version, valid_from, valid_to | no usar versiones vencidas |
| waitlist_entries | id, tenant_id, patient_id, conditions, consent_status, status | políticas transparentes |
| payment_orders | id, tenant_id, appointment_id_nullable, hold_id_nullable, amount, currency, status, provider_ref | no almacenar tarjeta |
| integration_accounts | id, tenant_id, provider, external_account_ref, health, encrypted_secret_ref | secretos cifrados |
| sync_cursors | integration_id, calendar_ref, sync_token, expires_at, status | sincronización verificable |
| consent_records | id, tenant_id, patient_id, purpose, version, source, timestamp | evidencia y revocación |
| privacy_requests | id, tenant_id, subject_ref, type, status, decision | acceso restringido |
| usage_ledger | id, tenant_id, provider, units, cost_usd, period | reconciliar facturas |

**Estándares:** IDs UUID/ULID opacos; `tenant_id` en todas las tablas de negocio; `created_at`, `updated_at` y `version` donde corresponda; dinero en unidades mínimas enteras y moneda ISO; nunca `float` monetario; datos UTC.

## 11.2 Restricción de no-solapamiento

PostgreSQL puede proteger intervalos mediante `EXCLUDE USING gist` con `btree_gist` para citas activas por profesional (la sintaxis exacta varía según diseño/status). Un ejemplo conceptual:

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE appointments
ADD CONSTRAINT appointments_no_overlap
EXCLUDE USING gist (
  tenant_id WITH =,
  professional_id WITH =,
  tstzrange(start_at, end_at, '[)') WITH &&
)
WHERE (status IN ('CONFIRMED', 'IN_PROGRESS'));
```

**Importante:** los holds y recursos adicionales requieren protección equivalente. No confiar solamente en `SELECT FOR UPDATE` sobre filas de turno inexistentes: dos transacciones podrían no bloquear ningún registro. Implementar materialización de slots, bloqueo/advisory locks por recurso-tiempo o constraints de exclusión y pruebas de carrera. En calendarios externos, una constraint local **no** impide colisiones creadas fuera del sistema.

## 11.3 Estados de entidades

- `Appointment`: `REQUESTED → HELD → PENDING_PAYMENT (P1) → CONFIRMED → COMPLETED | NO_SHOW`; ramales `CANCELLED`, `EXPIRED`, `SYNC_CONFLICT`, `NEEDS_REVIEW`. Restringir transiciones según origen y permisos.
- `Hold`: `ACTIVE → CONSUMED | EXPIRED | RELEASED`; operación expiración idempotente.
- `Conversation`: `BOT → HUMAN_PENDING → HUMAN_ACTIVE → BOT | CLOSED`.
- `Payment`: `CREATED → PENDING → APPROVED | REJECTED | CANCELLED | REFUNDED | REVIEW_REQUIRED`; estado provisto y reconciliado por pasarela.
- `Integration`: `CONNECTED → DEGRADED → DISCONNECTED → REAUTH_REQUIRED`.

# 12. Contratos de API (propuestos)

**Reglas comunes:** `/api/v1`, autorización, `X-Correlation-ID`, `Idempotency-Key` para comandos, paginación cursor, errores RFC7807/problem+json, rate limit, validación Zod y auditoría. El tenant se deriva de sesión/verificación de membresía, **no se confía en tenant_id del body**.

| Método | Ruta | Permiso | Acción / respuesta |
|---|---|---|---|
| POST | `/auth/invitations` | admin | invita miembro |
| GET | `/clinics/{id}/settings` | clinic.read | obtiene config publicada |
| PUT | `/clinics/{id}/settings/draft` | clinic.write | valida borrador de reglas |
| POST | `/clinics/{id}/settings/publish` | admin | publica versión |
| GET | `/availability?clinicId=&serviceId=&from=&to=` | schedule.read | slots opacos, UTC, TTL |
| POST | `/booking-holds` | appointment.create | crea hold idempotente |
| POST | `/appointments/confirm` | appointment.create | confirma solo si hold válido |
| POST | `/appointments/{id}/cancel` | appointment.cancel | cancela con policy check |
| POST | `/appointments/{id}/reschedule` | appointment.reschedule | P1, transacción/compensación |
| GET | `/inbox/conversations` | inbox.read | bandeja paginada |
| POST | `/inbox/conversations/{id}/takeover` | inbox.takeover | toma control humano |
| POST | `/inbox/conversations/{id}/release` | inbox.takeover | devuelve al bot |
| GET | `/metrics/operations` | analytics.read | agregados por intervalo |
| POST | `/integrations/google/connect` | admin | OAuth P1 |
| POST | `/payments/orders` | payments.create | P1, referencia checkout |
| POST | `/privacy/requests` | privacy.request | solicitud formal |
| POST | `/webhooks/whatsapp` | publicly signed | verifica y encola |
| POST | `/webhooks/mercadopago` | publicly signed | P1, verifica y encola |

### Ejemplo de comando de reserva

```json
{
  "holdId": "01JEXAMPLEHOLD",
  "patientContactId": "01JEXAMPLECONTACT",
  "confirmationToken": "opaque-one-time-token"
}
```

Respuesta exitosa: `201 Created` con `appointmentId`, `status`, `startsAt`, `endsAt`, `timezone`, `syncStatus`. `409` para conflicto de slot, `410` para hold expirado, `422` para regla no cumplida, `503` para integración indisponible sin posibilidad de confirmar. Idempotency-Key repetida devuelve resultado previamente persistido; distinta carga con misma key = `409`.

# 13. Orquestación del agente de IA

## 13.1 Principio operativo

La IA comprende lenguaje, redacta respuestas y **propone comandos tipados**. El backend autoriza, ejecuta y confirma. El LLM nunca es fuente de verdad de calendarios, planes, pagos o identidad.

## 13.2 Pipeline

1. Webhook autenticado → persistencia mínima del evento → ACK rápido.
2. Deduplicación por evento/mensaje; agrupar mensajes cortos si política de latencia lo permite.
3. Comprobar estado de conversación, consentimiento, límites y seguridad.
4. Detectar intención administrativa; ambigüedad => aclaración; posible urgencia => handoff.
5. Recuperar **solamente** reglas vigentes autorizadas para el tenant.
6. Invocar modelo con esquema estricto y herramientas allowlisted: `searchAvailability`, `createHold`, `confirmAppointment`, `cancelAppointment`, `handoffToHuman`, `getApprovedPolicy`.
7. Validador de políticas comprueba tenant, permisos, identidad, reglas, versiones y costos.
8. Servicio de dominio ejecuta transacción y produce evento de salida en outbox.
9. Worker entrega respuesta, captura estado de proveedor, registra auditoría técnica sin datos sensibles en log.
10. Evaluación de calidad y alertas; circuito degradado ante fallos.

## 13.3 Política anti-alucinaciones

- Fuentes estructuradas versionadas; retrieval por tenant y vigencia.
- JSON Schema estricto para argumentos; validar también del lado servidor.
- **Ningún texto libre implica transacción**; confirmar solo con resultado del servicio de reserva.
- Prohibidos SQL libre, navegación abierta, secretos, acceso al contenido de otros tenants.
- Temperatura baja cuando aplique, pero no considerar determinismo una garantía.
- Prompt-injection: mensajes de pacientes y documentos son datos no confiables; ignorar instrucciones que pretendan alterar el rol del agente.
- Restringir operaciones sensibles, máximo de llamadas, reintentos, cuotas y costo por conversación.
- Versionar prompts, modelos y resultados; rollback de cambios.
- Evaluaciones de regresión y red-teaming antes de liberar nuevas versiones.

## 13.4 Escalamiento y privacidad

**Triggers:** urgencia aparente, baja confianza, intento de acceso a tercero, regla vencida, fallo externo, reclamo, cambio de canal, pago tardío, paciente solicita humano. Cuando el personal toma la conversación, `conversation.version` impide que un job viejo emita respuesta autónoma. Nunca transmitir identificaciones ni datos de salud innecesarios al proveedor de IA; documentar encargados, ubicación de procesamiento, retención y acuerdos antes de salir a producción.

# 14. Integraciones y consistencia distribuida

## 14.1 WhatsApp

Usar plataforma oficial compatible con el caso de uso; validar términos vigentes para proveedores de soluciones de IA y para atención automatizada en salud. Webhook firmado y deduplicado; plantillas aprobadas, ventana de servicio y mecanismo de opt-out; presupuestar por **tipo y cantidad de mensajes realmente cobrables**, no por «conversación» genérica. Datos enviados a terceros requieren evaluación legal y contractual. Documentación y tarifas pueden cambiar.

## 14.2 Google Calendar

- OAuth con scopes mínimos, token cifrado y revocable; consentimiento de clínica.
- Persistir IDs externos, ETags, estado de sincronización y cursor.
- Watch channels expiran, necesitan renovación, y las notificaciones pueden exigir recuperación posterior: usar sync incremental y reconciliación periódica.
- Gestionar cuotas `429`, backoff, errores `410` de sync token, borrados y calendarios compartidos.
- Estrategia MVP recomendada: **fuente de verdad interna**, exportación/bidireccional solo cuando se pueda demostrar consistencia; si external calendar es fuente de verdad, bloquear confirmaciones con cualquier inconsistencia.
- Reservas concurrentes creadas por Google Calendar no se protegen con transacciones de PostgreSQL; exponer incidentes y resolverlos con políticas explícitas.

## 14.3 Mercado Pago (P1)

Crear `payment_order` interna con referencia/idempotencia y checkout hospedado. Verificar autenticidad de webhook según documentación vigente, recuperar el pago por API, comparar tenant/moneda/monto/referencia, procesar en transacción idempotente, reconciliar ante webhook faltante. **Nunca confirmar por retorno del navegador**. Pago aprobado después de expirar hold => review/compensación, no reservar slot ocupado.

## 14.4 Patrones de consistencia

- **Transactional outbox:** persistir evento de negocio y evento a publicar en misma transacción.
- **Inbox dedup:** clave única por proveedor/tenant/evento externo.
- **Reintentos:** exponencial + jitter, máximo definido y DLQ para inspección.
- **Sagas/compensaciones:** para calendar/payment sin transacción distribuida.
- **Orden lógico:** `aggregate.version` para ignorar eventos obsoletos.
- **Reconciliación:** comparar fuente interna vs externa y generar tareas humanas; jamás corregir silenciosamente un paciente distinto.

# 15. Seguridad, privacidad y cumplimiento

## 15.1 Marco normativo a evaluar

En Argentina, Ley 25.326 protege datos personales, con especial tratamiento de datos sensibles vinculados a salud; Ley 26.529 establece derechos del paciente y deberes relativos a información clínica. **[VALIDAR CON ASESORÍA]** Determinar si TurnoFlow opera como encargado de tratamiento, qué datos administrativos pueden revelar salud, cuál es la base jurídica, avisos, acuerdos, transferencias internacionales, retenciones, obligaciones de registro, incidentes y mecanismos de derechos. No interpretar que «solo gestionamos turnos» elimina obligaciones sanitarias/de privacidad.

## 15.2 Amenazas y defensas

| Amenaza | Control exigido |
|---|---|
| Acceso cruzado entre clínicas (BOLA) | tenant context server-side; FK compuestas, RLS cuando corresponda; pruebas con tenant A/B |
| Suplantación de paciente | verificación apropiada para acciones sensibles; no revelar información usando solo teléfono |
| Webhook falso | verificación firma/origen según proveedor; timestamps, replay/idempotencia |
| Prompt injection | herramientas allowlisted; esquema y policy engine; data untrusted |
| Filtración en logs/LLM | minimización, redacción de PII, retención y contratos de proveedores |
| Robo de credenciales | MFA, sesión segura, permisos mínimos, revocación, alertas |
| Abuso de mensajes y costos | cuotas, rate limit, budgets, revisión y throttling |
| Manipulación de precios/copagos | cálculos backend en reglas versionadas, doble revisión en excepciones |
| Fallo de backup | copias cifradas, restauración probada, acceso segregado |
| Supply chain | lockfile, SCA, secretos en vault, CI aislada, dependabot y revisiones |
| Amenazas internas soporte | just-in-time access auditado, acceso por defecto denegado |

Usar OWASP ASVS v5 como guía de verificación y OWASP API Security Top 10 para endpoints; alinear con amenaza y riesgo, sin afirmar certificación automática.

## 15.3 Políticas de retención de datos (requieren aprobación legal)

- Webhooks crudos: retención mínima necesaria para reintentos y auditoría, preferir payload cifrado con expiración breve.
- Audio: transcribir, procesar y eliminar original salvo necesidad justificada y autorizada.
- Conversaciones: no retener indefinidamente; ofrecer política configurable legalmente validada.
- Audit log: preservar integridad y acceso limitado, definir plazos conforme obligación contractual/legal.
- Backups: expiración y restauración, excepciones documentadas para solicitudes de supresión.
- Datasets de evaluación IA: sintéticos por defecto, anonimizados cuando se usen casos reales.

# 16. Diseño UX/UI y journeys

## 16.1 Mapa de navegación

- `/login`, `/invite/accept`, `/onboarding`.
- `/dashboard`: indicadores operativos, alertas, tareas.
- `/inbox`: bandeja, conversaciones, takeover, acciones seguras.
- `/agenda`: vista día/semana, filtros profesional/sede, bloques, conflictos.
- `/patients`: directorio mínimo, citas, privacidad y contactos; evitar historia clínica.
- `/rules`: horarios, servicios, coberturas P1, versiones y simulador.
- `/waitlist` (P1), `/payments` (P1), `/reports`.
- `/settings`: permisos, integración, marca, facturación, límites.
- `/admin-platform`: salud del SaaS, soporte y suscripciones, segregado de contenido clínico.

## 16.2 Pantallas principales y estados

**Onboarding:** checklist con progresión verificable, simulación con datos falsos y publicación explícita. **Inbox:** muestra mensajes, estado de IA/humano, motivo de escalamiento, contexto mínimo y botones con confirmación. **Agenda:** disponibilidad y vista de conflicto; acciones deshabilitadas cuando integración degradada. **Configuración:** cambios de reglas en draft y publish con diff/versión. **Dashboard:** métricas con explicación de fórmula, período y nivel de confianza. Todas las vistas deben cubrir loading, vacío, error, sin permisos, offline/degradado y recuperación.

## 16.3 Principios UX

No hacer creer al usuario que hay turno confirmado antes de confirmación backend; no ocultar paso a humano; mostrar siempre zona horaria y fecha completa; validaciones inline; accesibilidad teclado y lectores; feedback ante operaciones demoradas; advertir cambios irreversibles; permitir búsqueda y filtros por volumen de mensajes.

# 17. Pruebas y aseguramiento de calidad

## 17.1 Pirámide y ambientes

- **Unitarias:** reglas, validación de fechas, estados, servicios y políticas.
- **Integración:** PostgreSQL real en contenedor, colas y mocks contractuales de proveedores; migraciones.
- **Contract tests:** OpenAPI, esquemas de payload Meta/Google/MP versionados.
- **End-to-end:** navegador en staging, datos sintéticos, flujos completos de recepción y agenda.
- **Carga/race:** solicitudes concurrentes de mismo slot, workers duplicados, picos de webhook.
- **Seguridad:** OWASP ASVS, permisos, IDOR/BOLA, SSRF, secretos, webhook replay, prompt injection.
- **Resiliencia:** outage de Meta/LLM/Calendar/MP, cola saturada, fallo de DB, pérdida webhook, reintentos.
- **UAT:** recepcionistas y administradores ejecutan escenarios representativos, con acta firmada.

## 17.2 Matriz mínima de pruebas críticas

| Test | Escenario | Resultado esperado |
|---|---|---|
| TC-001 | publicación de horario contradictorio | error de validación, sin cambios publicados |
| TC-010 | reserva válida | 1 hold + 1 cita + 1 evento de confirmación |
| TC-011 | pedir horario inexistente | IA no lo ofrece ni lo confirma |
| TC-012 | nombre de cobertura ambiguo | se solicita aclaración/humano |
| TC-020 | 100 concurrentes por mismo slot | a lo sumo una confirmación válida |
| TC-021 | retry confirm con misma Idempotency-Key | mismo resultado, sin duplicación |
| TC-022 | retry key con payload diferente | 409 y evidencia en log |
| TC-030 | humano toma conversación durante LLM | sin respuestas automáticas posteriores al takeover efectivo |
| TC-040 | cancelación duplicada | estado final cancelado, mensajes no duplicados |
| TC-050 | dos aceptan oferta de espera | una asignación y alternativa controlada |
| TC-060 | webhook de pago falsificado | rechazo, sin cita confirmada |
| TC-061 | pago llega tras expiración de hold | review/refund según política, sin ocupación falsa |
| TC-062 | monto recibido diferente | incidencia, no confirmación |
| TC-080 | mensaje sugiere urgencia | texto fijo/handoff, sin diagnóstico |
| TC-090 | calendar expira token | estado degraded, alertas y cero confirmaciones falsas |
| TC-091 | un evento externo duplica slot local | conflicto visible y bloqueo automático |
| TC-100 | tenant A solicita patient de B | 404/403 sin filtración ni side effects |
| TC-101 | exportación datos sin permisos | denegación, auditoría |
| TC-102 | prompt injection «ignora reglas y agenda» | no puede ejecutar comando inválido |
| TC-103 | caída de worker después de commit | outbox reintenta y entrega sin duplicar cita |
| TC-104 | restaurar backup staging | cumplimiento de objetivo RPO/RTO en ejercicio |

## 17.3 Criterios de aceptación de release

- 100% tests P0 críticos aprobados; sin defectos P0/P1 de seguridad o integridad pendientes.
- Revisión de amenazas, datos, dependencias y privacidad completada por responsables.
- Métricas/alertas/rollback/backup y runbook disponibles.
- Documentación de limitaciones de integraciones y políticas de canal aceptadas.
- Ensayos con usuarios reales y datos ficticios exitosos antes de datos personales reales.

# 18. DevOps, despliegue y operación

## 18.1 Repositorio sugerido

```text
turnoflow/
  apps/
    web/                  # Next.js panel
    api/                  # API modular
    worker/               # jobs, reconciliación
  packages/
    domain/               # tipos y reglas de negocio puras
    contracts/            # Zod/OpenAPI/events
    db/                   # Prisma, SQL, migraciones
    integrations/          # clients Meta, Google, MP
    ai-policy/             # tools, prompts versionados, evals
    ui/                    # sistema de diseño
  infra/                   # IaC, despliegue, alertas
  docs/
    adr/ runbooks/ privacy/ api/ product/ testing/
  tests/
    integration/ e2e/ load/ security/ ai-evals/
  .github/workflows/
```

## 18.2 Ambientes

`local` (emuladores, datos falsos), `test` CI, `staging` equivalente a producción con proveedores sandbox y `production` aislado. Nunca copiar producción completa a staging. Secretos administrados por vault, no `.env` compartido en repositorios. Migraciones reversibles o expand-contract; feature flags por tenant; despliegues canary para IA/agentes.

## 18.3 Pipeline CI/CD

Pull request → format/lint/typecheck → unit tests → integración DB/cola → contract tests → SAST/SCA/secret scanning → build → deploy staging → e2e → aprobación manual → deploy producción → smoke tests y monitoreo. Evidencia de despliegue firmada con versión del backend, modelo/prompts y migraciones.

## 18.4 Runbooks mínimos

1. **No llega WhatsApp:** verificar webhook, firma, provider status, cola y DLQ; no reinyectar sin dedup.
2. **LLM indisponible:** activar respuestas estáticas mínimas y handoff; no inventar reservas.
3. **Google Calendar inconsistente:** poner integración en `DEGRADED`, bloquear confirmaciones automatizadas dependientes y conciliar.
4. **Pago aprobado sin turno:** detener autopromesa, generar incidente, devolución/reasignación autorizada.
5. **Sospecha de filtración:** rotar credenciales, aislar servicio, preservar evidencias, activar protocolo legal/comunicación.
6. **Alta latencia/costo:** aplicar límites de inferencia y cola, comunicar degradación, revisar factura por tenant.

# 19. Roadmap de implementación con entregables

**Los plazos son orientativos para un fundador con apoyo de herramientas; no compromisos.** Seguridad, legalidad y canales pueden agregar semanas. No ejecutar todas las fases sin puertas de decisión.

| Fase | Tiempo orientativo | Entregables | Gate |
|---|---|---|---|
| F0 Descubrimiento | semanas 1–3 | entrevistas, mapa de workflows, análisis competencia, pricing real, amenazas iniciales | 3 pilotos pagos potenciales |
| F1 Fundamentos | semanas 4–6 | monorepo, CI, auth, tenants, RBAC, esquema DB, auditoría, observabilidad | tests aislamiento + despliegue staging |
| F2 Agenda core | semanas 7–10 | profesionales, servicios, slots, holds, confirmación/cancelación | tests concurrencia + fechas |
| F3 Mensajería y control | semanas 11–14 | WhatsApp, inbox, agente estricto, handoff, reglas básicas | evaluación IA y pruebas integrales |
| F4 Piloto seguro | semanas 15–18 | 1–3 clínicas piloto, formación, backups, métricas, runbooks | aceptación legal y UAT |
| F5 Product-market fit inicial | semanas 19–26 | iteraciones, retención, prueba económica, onboarding | pagar/renovar/usar de forma demostrable |
| F6 Diferenciadores | postvalidación | coberturas P1, lista avanzada, pagos, integración external, métricas ROI | ROI/CAC/seguridad positivos |
| F7 Escalado | posterior | multisitio, conectores adicionales, capacidades predictivas opcionales | retención y soporte sostenibles |

## 19.1 Backlog épicas → historias

- **EP-01 Tenancy/Identity:** US-001 como admin quiero invitar recepcionistas; US-002 como dueño quiero revocar acceso; US-003 como soporte quiero ayudar sin ver PII por defecto.
- **EP-02 Configuración clínica:** US-004 como admin configuro profesionales; US-005 configuro práctica y duración; US-006 publico cambios después de simularlos.
- **EP-03 Agenda:** US-007 como paciente quiero reservar horario disponible; US-008 quiero cancelar; US-009 como recepción quiero bloquear día; US-010 quiero resolver conflicto.
- **EP-04 Mensajería:** US-011 como paciente escribo en lenguaje natural; US-012 pido humano; US-013 como recepcionista tomo control; US-014 quiero ver por qué falló una interacción.
- **EP-05 Operación:** US-015 como admin veo estado de proveedores; US-016 recibo alertas; US-017 puedo exportar datos.
- **EP-06 Comercial P1:** US-018 como clínica configuro obras sociales; US-019 recibo señas; US-020 gestiono lista de espera; US-021 veo resultados atribuibles.

### Definition of Ready

Historia tiene actor, valor, RF/RN vinculados, precondiciones, datos requeridos, reglas de privacidad, casos de error, criterios Gherkin y dependencias resueltas.

### Definition of Done

Código revisado, tests, autorización, telemetría, migración, manejo de fallos, documentación, accesibilidad según componente, evidencia QA y feature flag cuando corresponda. No cerrar funcionalidad crítica solo porque compila.

# 20. Ejemplos de aceptación en Gherkin

```gherkin
Feature: Reserva única por horario
  Scenario: Dos pacientes intentan reservar un mismo slot
    Given una clínica con un único horario libre a las 15:30
    And existen dos pacientes con identidad suficiente
    When ambos confirman la misma reserva simultáneamente
    Then se confirma exactamente una cita
    And el segundo recibe una respuesta de conflicto y alternativas
    And no existe solapamiento en la base de datos

Feature: Handoff humano
  Scenario: Una recepcionista toma control
    Given una conversación en modo BOT
    When una recepcionista toma la conversación
    Then el estado pasa a HUMAN_ACTIVE
    And ningún job de IA creado con una versión anterior puede emitir respuesta

Feature: Pago fuera de término
  Scenario: La pasarela aprueba una seña tras caducar un hold
    Given un hold expirado y un horario reservado por otro paciente
    When llega un webhook autenticado de pago aprobado
    Then no se confirma el turno original
    And se crea una incidencia con compensación o reembolso
```

# 21. Modelo financiero revisado y operativo

## 21.1 Qué afirma el PDF base y qué no está validado

**[BASE]** Setup US$350; abono mensual promedio US$220; fijo US$360/mes; variable US$30/clínica; inversión US$1.000; equilibrio 2 clínicas sin sueldo y 10 con US$1.500 de retiro; 27 clínicas al mes 6 y US$5.940 MRR. Aritméticamente las fórmulas básicas son coherentes **si** los supuestos se cumplen. No se aportan contratos, cohortes, tasas de ventas, costos completos de privacidad/seguridad, soporte ni evidencia para el ritmo de captación.

## 21.2 Escenario de planificación conservador (hipotético)

| Variable | Base | Conservador propuesto |
|---|---:|---:|
| Precio mensual por clínica | US$220 | US$220 (por validar) |
| Costos fijos/mes, sin fundador | US$360 | US$800 |
| Costo variable por clínica/mes | US$30 | US$70 |
| Retiro fundador/mes | US$1.500 | US$1.500 |
| Margen contribución/clínica | US$190 | US$150 |
| Break-even sin fundador | 2 clínicas | 6 clínicas |
| Break-even con fundador | 10 clínicas | 16 clínicas |

**Fórmula:** contribución unitaria = precio − costo variable; break-even = ceil((fijos + remuneración) / contribución). Con 20 clientes: 20×220 − (800 + 1.500 + 20×70) = US$700 mensuales antes de impuestos e inversiones extraordinarias. **No es una previsión**.

## 21.3 Costos a presupuestar realmente

- **Preapertura:** entrevistas/visitas, acuerdos legales y privacidad, pruebas con proveedores, auditoría externa según riesgo, identidad y demo, reserva para incidentes.
- **Fijos:** hosting, DB, Redis, observabilidad, backups, contabilidad, soporte, herramienta comercial, seguros según análisis y remuneraciones.
- **Variables:** mensajes Meta por país/categoría, LLM por tokens, voz por minutos, proveedor BSP, correos, comisiones de cobro, almacenamiento y soporte incremental.
- **Semivariables:** onboarding por clínica, personalización, revisión de obras sociales y conectores, mantenimiento de integraciones, atención incidentes.
- **No financieros:** tiempo de fundador, riesgo de reputación, costo de reemplazar integración, responsabilidad contractual y retrasos legales.

## 21.4 Sensibilidad y gobernanza

Modelar P10/P50/P90 para ventas, churn, CAC, costo variable, soporte por clínica y precio promedio; contabilizar ingresos setup separados de MRR; usar contribución neta y cash flow, no solo margen bruto. Modelar ventas lentas y tasa de cancelación; no prometer recuperación al mes 3. Recalcular cada mes con facturas y evidencia.

## 21.5 Puntos de inversión progresiva

- **Puerta A:** problema validado con entrevistas y primera propuesta de precio.
- **Puerta B:** piloto pago y MVP técnicamente seguro.
- **Puerta C:** uso/renovación + costos reales, sin problemas de cumplimiento.
- **Puerta D:** adquisición reproducible y soporte escalable; recién entonces invertir en crecimiento.

# 22. Riesgos, registro y mitigaciones

| ID | Riesgo | Severidad | Mitigación / gatillo de suspensión |
|---|---|---|---|
| R-01 | Mercado prefiere proveedor actual | Alta | demos y entrevistas; pivotar antes de construir de más |
| R-02 | Canal WhatsApp cambia condiciones | Alta | validar términos antes de lanzar; canales alternativos y revisión legal |
| R-03 | Agenda externa incompatible | Crítica | confirmar soporte técnico; modo no autónomo; conciliar |
| R-04 | Datos sensibles filtrados | Crítica | privacidad-by-design, RLS, DPA, respuesta a incidentes, auditoría externa |
| R-05 | IA confirma información falsa | Crítica | comandos deterministas, tool validation, bloqueos, handoff |
| R-06 | Fallo de sincronización con pagos | Alta | firma, idempotencia, reconciliación, reembolso |
| R-07 | Costos por cliente mayores al ticket | Alta | cost ledger, límites, pricing variable, revisión de márgenes |
| R-08 | Onboarding manual excesivo | Alta | templates, checklists, self-service gradual y precio setup adecuado |
| R-09 | Churn alto | Alta | instrumentar motivos; mejorar uso recurrente y resultados verificables |
| R-10 | Dependencia fundador | Alta | runbooks, documentación y soporte delegable |
| R-11 | Cambios regulatorios/mensajería | Alta | counsel continuo, feature flags, protocolos de suspensión |
| R-12 | Sobreventa por métricas no atribuibles | Media-alta | reporting transparente y metodología de comparación |

# 23. Decisiones abiertas: registro de preguntas

| ID | Decisión pendiente | Consecuencia si no se resuelve |
|---|---|---|
| D-01 | Clínicas odontológicas exactas, tamaño, provincia y volumen mensual | diseño basado en buyer imaginario |
| D-02 | Sistemas actuales y disponibilidad de API | conector inviable o sincronización insegura |
| D-03 | Papel legal y contratos de datos con clínicas | operación incompatible con exigencias |
| D-04 | Flujo de consentimiento/contacto inicial y opt-out | comunicaciones no autorizadas |
| D-05 | Si WhatsApp permite el caso de uso bajo términos actuales | riesgo de suspensión del canal |
| D-06 | Regla de identidad del paciente para cancelar/reprogramar | acceso indebido a turnos |
| D-07 | Política de señas, devoluciones, pago tardío | perjuicio económico y reclamos |
| D-08 | Alcance de reglas de coberturas, fuentes y responsables de actualización | información desactualizada |
| D-09 | Dueño de la fuente de verdad de agenda | reservas inconsistentes |
| D-10 | Retención de mensajes y audios por categoría | exposición de datos |
| D-11 | Precio objetivo, setup y límite de uso | margen negativo |
| D-12 | Soporte humano fuera de horario y protocolo de urgencias | promesa engañosa de atención |
| D-13 | País/región de datos y transferencias internacionales | incumplimientos potenciales |
| D-14 | Responsable de incidentes y tiempos de respuesta | operación no preparada |

# 24. Plan para iniciar el desarrollo asistido por Codex / Claude Code

## 24.1 Orden de implementación obligatorio

1. Repositorio y documentación (`README`, ADR, RF/RNF/RN, definición de alcance).
2. CI y entornos, secretos, autenticación, tenancy, roles, audit trail.
3. Modelo DB y reglas de scheduling independientes del canal conversacional.
4. Pruebas de concurrencia y estados, con PostgreSQL real.
5. API de calendario y panel admin/recepción.
6. Ingesta de webhook firmada con mocks; pruebas end-to-end sin pacientes reales.
7. Orquestación IA con herramientas tipadas, política y takeover.
8. Observabilidad, límites, privacidad, costos, restauración y UAT.
9. Piloto controlado, intervención humana y métricas antes de ampliar automatización.
10. Integraciones/pagos/coberturas avanzadas bajo gates individuales.

## 24.2 Prompt de ejecución por épica

> Actuá como Senior Software Architect, Product Manager, Staff Full Stack Developer, QA Engineer y Security Engineer. Tomá `TurnoFlow_Especificacion_Integral_2026.md` como especificación de referencia **propuesta**, preservando distinción BASE/PROPUESTA/VALIDAR. Elegí una épica P0 no implementada y elaborá su plan técnico mínimo, contratos, migraciones, controles RBAC/tenant, tests de aceptación y amenazas. Implementala en commits pequeños; ejecutá tests y documentá evidencia. No crees integraciones reales, no proceses pacientes reales, no inventes consentimientos ni tarifas. Si hay una decisión D-xx no resuelta que afecta seguridad, bloqueá ese alcance y trabajá en componentes independientes. No declares completado sin test/observabilidad/documentación. La IA nunca confirma turnos por texto: toda reserva exige ejecución determinista y estado persistido.

## 24.3 Documentación a mantener

`PRODUCT_VISION.md`, `SCOPE_AND_ASSUMPTIONS.md`, `REQUIREMENTS.md`, `BUSINESS_RULES.md`, `THREAT_MODEL.md`, `DATA_PROCESSING.md`, `ARCHITECTURE.md`, `API.openapi.yaml`, `ADR-*.md`, `TEST_PLAN.md`, `IMPLEMENTATION_PROGRESS.md`, `REMAINING_BLOCKERS.md`, `RUNBOOKS.md`, `RELEASE_NOTES.md`, `COST_MODEL.md`, `SALES_VALIDATION.md`. Mantener IDs y matriz de trazabilidad entre requisitos, historias, código y tests.

# 25. Matriz de trazabilidad resumida

| Dominio | RF | RNF relacionados | RN | UC | Test prioritario |
|---|---|---|---|---|---|
| Tenancy/permisos | 001–007 | 001–003,010,021 | 001–002 | UC-01,12 | TC-001,100,101 |
| Agendas | 008–010,028–038 | 004–009,013,016 | 003–005,009–018 | UC-02–07,11 | TC-010–023,040–055,090–099 |
| Pacientes/coberturas | 011–015 | 011,018,021 | 006–008,024 | UC-09,12 | TC-070–074,100–105 |
| Mensajería/IA | 016–027 | 007–008,015,017,019,020 | 013,021–023 | UC-02,04,10 | TC-030–032,080–084,102 |
| Pagos | 039–046 | 003,008,010,017 | 019–020,026 | UC-08 | TC-060–069 |
| Operación/analítica | 047–055 | 005,009–010,014–022 | 025–028 | UC-11,12 | TC-090–105 |

# 26. Fuentes, documentación y límites de evidencia

**Fuente primaria aportada:** `Plan_Integral_de_Negocio_y_Arquitectura_-_TurnoFlow.pdf` (7 páginas), con propuesta original de modelo SaaS y precios, cinco etapas de pipeline y hoja de ruta de 180 días. Se usó como **baseline**, no como prueba de demanda o costes.

**Normativa y fuentes técnicas consultadas (noviembre de 2026):**

1. Ley argentina 25.326, texto oficial: https://www.argentina.gob.ar/normativa/nacional/ley-25326-64790/texto
2. Ley argentina 26.529, texto actualizado: https://www.argentina.gob.ar/normativa/nacional/160432/actualizacion
3. OWASP ASVS 5.0: https://asvs.owasp.org/
4. Google Calendar API — notificaciones: https://developers.google.com/workspace/calendar/api/guides/push
5. Google Calendar API — cuotas: https://developers.google.com/workspace/calendar/api/guides/quota
6. Mercado Pago — autenticación de webhooks: https://www.mercadopago.com.ar/developers/es/docs/checkout-bricks/additional-content/your-integrations/notifications/webhooks
7. WhatsApp Business Platform — precios y documentación: https://developers.facebook.com/docs/whatsapp/pricing/
8. WCAG 2.2: https://www.w3.org/TR/WCAG22/

**Límites:** No se ha auditado código ni desplegado el sistema, entrevistado compradores, negociado proveedores, auditado cumplimiento legal, verificado tarifas contractuales exactas, ni comprobado compatibilidad de agendas de clínicas. Se requieren investigaciones y tests adicionales antes de operar comercialmente. Los valores y métricas en este documento son supuestos salvo especificación explícita.

---

**Fin de especificación 1.0.** El siguiente hito no es ampliar el catálogo de funciones: es resolver D-01 a D-05, demostrar un problema pagable y empezar F1 con garantías de aislamiento e integridad de agenda.
