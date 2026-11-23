import { DomainError } from './errors.ts';

export const CONVERSATION_MODES = ['BOT', 'HUMAN_PENDING', 'HUMAN_ACTIVE', 'CLOSED'] as const;
export type ConversationMode = (typeof CONVERSATION_MODES)[number];

/** Spec 11.3: BOT -> HUMAN_PENDING -> HUMAN_ACTIVE -> BOT | CLOSED. A closed conversation is reopened by a new inbound message. */
const TRANSITIONS: Record<ConversationMode, readonly ConversationMode[]> = {
  BOT: ['HUMAN_PENDING', 'HUMAN_ACTIVE', 'CLOSED'],
  HUMAN_PENDING: ['HUMAN_ACTIVE', 'BOT', 'CLOSED'],
  HUMAN_ACTIVE: ['BOT', 'CLOSED'],
  CLOSED: ['BOT'],
};

export const canTransitionConversation = (from: ConversationMode, to: ConversationMode): boolean => TRANSITIONS[from].includes(to);

export function assertConversationTransition(from: ConversationMode, to: ConversationMode): void {
  if (!canTransitionConversation(from, to)) throw new DomainError('INVALID_TRANSITION', `Conversation cannot go from ${from} to ${to}`);
}

/** RF-022: automatic replies are only allowed while the bot owns the conversation. */
export const botMayReply = (mode: ConversationMode): boolean => mode === 'BOT';
