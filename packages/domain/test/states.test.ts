import { describe, expect, it } from 'vitest';
import {
  APPOINTMENT_STATUSES, assertAppointmentTransition, assertHoldTransition, canTransitionAppointment, isDomainError,
} from '../src/index.ts';

describe('state machines', () => {
  it('allows the happy path', () => {
    expect(canTransitionAppointment('HELD', 'CONFIRMED')).toBe(true);
    expect(canTransitionAppointment('CONFIRMED', 'CANCELLED')).toBe(true);
  });

  it('treats terminal states as final (RN-014: cancelled never returns to confirmed)', () => {
    for (const t of ['CANCELLED', 'EXPIRED', 'COMPLETED', 'NO_SHOW'] as const) {
      for (const to of APPOINTMENT_STATUSES) expect(canTransitionAppointment(t, to)).toBe(false);
    }
  });

  it('throws INVALID_TRANSITION', () => {
    try {
      assertAppointmentTransition('CANCELLED', 'CONFIRMED');
      expect.unreachable();
    } catch (e) {
      expect(isDomainError(e, 'INVALID_TRANSITION')).toBe(true);
    }
    expect(() => assertHoldTransition('CONSUMED', 'ACTIVE')).toThrow();
    expect(() => assertHoldTransition('ACTIVE', 'CONSUMED')).not.toThrow();
  });
});
