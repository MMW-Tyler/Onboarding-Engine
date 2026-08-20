import { describe, it, expect } from 'vitest';
import { backoffMs, defaultMaxAttempts, defaultProfileFor } from './retry.js';

describe('retry policy (spec section 09)', () => {
  it('maps safety classes to default profiles', () => {
    expect(defaultProfileFor('costly')).toBe('costly');
    expect(defaultProfileFor('read-safe')).toBe('standard');
    expect(defaultProfileFor('reversible-write')).toBe('standard');
  });

  it('uses the documented default attempt counts', () => {
    expect(defaultMaxAttempts('flaky')).toBe(5);
    expect(defaultMaxAttempts('standard')).toBe(3);
    expect(defaultMaxAttempts('ai')).toBe(2);
    expect(defaultMaxAttempts('costly')).toBe(1);
  });

  it('costly never waits (single attempt, no backoff)', () => {
    expect(backoffMs('costly', 1)).toBe(0);
  });

  it('standard backoff grows exponentially and respects the 2-min cap', () => {
    expect(backoffMs('standard', 1)).toBe(2000);
    expect(backoffMs('standard', 2)).toBe(4000);
    expect(backoffMs('standard', 3)).toBe(8000);
    expect(backoffMs('standard', 20)).toBe(120000); // capped at 2 min
  });

  // The `poll` profile is how a step waits on someone else's async job: base ==
  // cap, so the gap is FLAT rather than doubling, and the step is re-claimed on a
  // steady cadence until it succeeds or runs out of attempts.
  it('poll waits a flat 60s on every attempt', () => {
    expect(backoffMs('poll', 1)).toBe(60_000);
    expect(backoffMs('poll', 2)).toBe(60_000);
    expect(backoffMs('poll', 31)).toBe(60_000);
    expect(defaultMaxAttempts('poll')).toBe(32); // ~30 min of polling
  });

  it('flaky backoff stays within the 5-min cap (with jitter)', () => {
    for (let attempt = 1; attempt <= 20; attempt++) {
      const ms = backoffMs('flaky', attempt);
      expect(ms).toBeGreaterThanOrEqual(0);
      expect(ms).toBeLessThanOrEqual(5 * 60_000);
    }
  });
});
