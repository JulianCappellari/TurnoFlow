# Prompt Log

| Prompt ID | Date/time | Agent | Task ID | Safe request | Acceptance criteria | Outcome | Session |
|---|---|---|---|---|---|---|---|
| P-20261123-001 | 2026-11-23 | Claude Code | T-20261123-001 | Act as autonomous senior team on TurnoFlow using the integral spec; implement only P0; start with domain+db (schema sec. 11, scheduling engine), run TC-020 (100 concurrent same slot) green; connect WhatsApp/LLM last, after HTTP availability API + reception panel. | TC-020 passes; schema P0; no P1/P2 | Core milestone done (PARTIAL overall) | none |
| P-20261123-002 | 2026-11-23 | Claude Code | T-20261123-002 | User approved: continue with apps/api (HTTP availability + booking). | API calls same SchedulingService; tenant from session | API done | none |
| P-20261123-003 | 2026-11-23 | Claude Code | T-20261123-003 | User approved: build the basic reception panel. | Agenda + book + cancel through the API, accessible | Panel done, browser-verified | none |
| P-20261123-004 | 2026-11-23 | Claude Code | T-20261123-004 | User approved: build the inbox (conversation list, human takeover). | Takeover blocks bot replies (TC-030); no simultaneous human replies | Inbox done, browser-verified | none |
| P-20261123-005 | 2026-11-23 | Claude Code | T-20261123-005 | User approved: signed WhatsApp webhook against a simulated provider. | Verified signature, dedupe, ordering, retries, no automatic reply after takeover | Webhook + workers done, verified live | none |
| P-20261123-006 | 2026-11-23 | Claude Code | T-20261123-006 | User approved: AI agent behind a simulated LLM interface. | Model proposes, backend decides; no confirmation by text; takeover wins; injection-safe | Agent core done, verified live | none |
| P-20261123-007 | 2026-11-23 | Claude Code | T-20261123-007 | User asked whether the project is ready for Codex and for a very detailed implementation guide. | Honest readiness verdict + detailed how-to | AGENTS.md + CODEX_GUIDE.md written; gaps fixed (expireHolds scheduling, createdb script, spec in repo, memory docs) | none |
