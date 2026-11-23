/** ISO weekday: 1 = Monday ... 7 = Sunday. Minutes are local minutes since midnight in the clinic timezone. */
export interface WeeklyRule {
  weekday: number;
  startMinute: number;
  /** Exclusive end; 1440 means midnight at the end of the day. */
  endMinute: number;
}

export interface Interval {
  start: Date;
  end: Date;
}

export interface Slot {
  startsAt: Date;
  /** End of the practice itself (RN-003: start + service duration). */
  endsAt: Date;
  /** End of the exclusive occupancy (practice + buffer). Used for overlap protection. */
  occupiedUntil: Date;
}

export interface GenerateSlotsInput {
  /** IANA zone of the clinic (RN-009). */
  timezone: string;
  rules: WeeklyRule[];
  /** Holidays, absences and manual blocks. A slot's practice interval may not intersect them. */
  blocks: Interval[];
  /** Occupancy intervals of active appointments and active holds. */
  busy: Interval[];
  durationMin: number;
  bufferMin: number;
  stepMin: number;
  /** Slot starts must satisfy from <= start < to. */
  from: Date;
  to: Date;
  now: Date;
  minNoticeMin?: number;
}
