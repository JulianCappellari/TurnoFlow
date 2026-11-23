import { DomainError } from '../errors.ts';

export const APPOINTMENT_STATUSES = [
  'REQUESTED', 'HELD', 'PENDING_PAYMENT', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED',
  'NO_SHOW', 'CANCELLED', 'EXPIRED', 'SYNC_CONFLICT', 'NEEDS_REVIEW',
] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

/** Statuses that occupy the professional's time. Mirrors the EXCLUDE constraint in migration 001. */
export const BLOCKING_APPOINTMENT_STATUSES: readonly AppointmentStatus[] = [
  'CONFIRMED', 'IN_PROGRESS', 'NEEDS_REVIEW', 'SYNC_CONFLICT',
];

const APPOINTMENT_TRANSITIONS: Record<AppointmentStatus, readonly AppointmentStatus[]> = {
  REQUESTED: ['HELD', 'CANCELLED', 'EXPIRED'],
  HELD: ['PENDING_PAYMENT', 'CONFIRMED', 'EXPIRED', 'CANCELLED'],
  PENDING_PAYMENT: ['CONFIRMED', 'EXPIRED', 'CANCELLED', 'NEEDS_REVIEW'], // P1 path, kept for the model
  CONFIRMED: ['IN_PROGRESS', 'COMPLETED', 'NO_SHOW', 'CANCELLED', 'SYNC_CONFLICT', 'NEEDS_REVIEW'],
  IN_PROGRESS: ['COMPLETED'],
  SYNC_CONFLICT: ['CONFIRMED', 'CANCELLED', 'NEEDS_REVIEW'],
  NEEDS_REVIEW: ['CONFIRMED', 'CANCELLED'],
  COMPLETED: [], NO_SHOW: [], CANCELLED: [], EXPIRED: [],
};

export const HOLD_STATUSES = ['ACTIVE', 'CONSUMED', 'EXPIRED', 'RELEASED'] as const;
export type HoldStatus = (typeof HOLD_STATUSES)[number];

const HOLD_TRANSITIONS: Record<HoldStatus, readonly HoldStatus[]> = {
  ACTIVE: ['CONSUMED', 'EXPIRED', 'RELEASED'],
  CONSUMED: [], EXPIRED: [], RELEASED: [],
};

export const canTransitionAppointment = (from: AppointmentStatus, to: AppointmentStatus): boolean =>
  APPOINTMENT_TRANSITIONS[from].includes(to);

export const canTransitionHold = (from: HoldStatus, to: HoldStatus): boolean =>
  HOLD_TRANSITIONS[from].includes(to);

export function assertAppointmentTransition(from: AppointmentStatus, to: AppointmentStatus): void {
  if (!canTransitionAppointment(from, to)) {
    throw new DomainError('INVALID_TRANSITION', `Appointment cannot go from ${from} to ${to}`);
  }
}

export function assertHoldTransition(from: HoldStatus, to: HoldStatus): void {
  if (!canTransitionHold(from, to)) {
    throw new DomainError('INVALID_TRANSITION', `Hold cannot go from ${from} to ${to}`);
  }
}
