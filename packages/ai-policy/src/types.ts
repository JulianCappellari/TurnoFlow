/** Provider-neutral contract between the orchestrator and any language model (spec 10.2: "gateway adaptable a proveedores"). */

export const TOOL_NAMES = ['searchAvailability', 'createHold', 'confirmAppointment', 'cancelAppointment', 'handoffToHuman', 'getApprovedPolicy'] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export interface ToolSpec { name: ToolName; description: string }

export type LlmMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string }
  | { role: 'tool'; name: string; result: unknown };

/** Everything the model may know. No patient identity, phone number, appointment id or token is ever included. */
export interface AgentContext {
  clinicName: string;
  /** Names of bookable practices. */
  services: string[];
  /** Today in the clinic's timezone (YYYY-MM-DD). */
  today: string;
  patientLinked: boolean;
  /** Slots already shown to the patient, by opaque reference. */
  offers: { ref: string; label: string }[];
  /** A temporary hold waiting for the patient's explicit yes. */
  pending: { label: string } | null;
}

export interface LlmRequest {
  promptVersion: string;
  system: string;
  messages: LlmMessage[];
  tools: ToolSpec[];
  context: AgentContext;
}

/** One model turn: either text for the patient or a single tool call. */
export type LlmTurn = { type: 'text'; text: string } | { type: 'tool_call'; name: string; args: unknown };

export interface LlmGateway {
  complete(req: LlmRequest): Promise<LlmTurn>;
}

export interface Offer {
  ref: string; professionalId: string; serviceId: string; serviceName: string; professionalName: string;
  startsAt: string; label: string; offeredAt: string;
}
export interface PendingHold {
  holdId: string; token: string; label: string; serviceName: string; expiresAt: string; heldDuringMessageId: string;
}
/** Server-side memory of the conversation. Persisted in conversations.agent_state, never shown to the model. */
export interface AgentState { offers: Offer[]; pending?: PendingHold }

export interface AgentPolicy {
  maxLlmCalls: number;
  maxToolCalls: number;
  llmTimeoutMs: number;
  /** Automatic replies allowed per conversation per hour (cost and abuse control, RNF-017). */
  maxBotMessagesPerHour: number;
  offerTtlMin: number;
  maxOffers: number;
  maxSearchDays: number;
}
export const DEFAULT_POLICY: AgentPolicy = {
  maxLlmCalls: 6, maxToolCalls: 5, llmTimeoutMs: 20_000, maxBotMessagesPerHour: 20, offerTtlMin: 30, maxOffers: 6, maxSearchDays: 14,
};

export type RunOutcome =
  | 'REPLIED' | 'HANDOFF' | 'HANDOFF_REQUESTED' | 'HANDOFF_RATE_LIMIT' | 'URGENCY' | 'HOLD_RELEASED' | 'REJECTED_OUTPUT'
  | 'DISCARDED_TAKEOVER' | 'DISCARDED_AFTER_ACTION' | 'FALLBACK_ERROR'
  | 'SKIPPED_NOT_BOT' | 'SKIPPED_SUPERSEDED' | 'SKIPPED_DUPLICATE' | 'SKIPPED_NOT_FOUND' | 'LOCKED';
