import type { RetryProfile, SafetyClass } from '../types.js';

/**
 * Retry policy by class (spec section 09). Steps declare their own maxAttempts;
 * this module decides the backoff delay between attempts and the default cap.
 *
 *   network/flaky (DNS, Mailgun verify, 5xx) : 5 attempts, exp + jitter, cap 5 min
 *   standard (Slack, HubSpot, ClickUp, Drive, GHL) : 3, exp, cap 2 min
 *   AI synthesis : 2, exp
 *   costly (Namecheap) : 1, none - a human investigates
 */

interface ProfileSpec {
  defaultMaxAttempts: number;
  baseMs: number;
  capMs: number;
  jitter: boolean;
}

const PROFILES: Record<RetryProfile, ProfileSpec> = {
  flaky: { defaultMaxAttempts: 5, baseMs: 2000, capMs: 5 * 60_000, jitter: true },
  standard: { defaultMaxAttempts: 3, baseMs: 2000, capMs: 2 * 60_000, jitter: false },
  ai: { defaultMaxAttempts: 2, baseMs: 3000, capMs: 60_000, jitter: false },
  costly: { defaultMaxAttempts: 1, baseMs: 0, capMs: 0, jitter: false },
};

/** Pick a sensible default profile from the safety class when a step doesn't override. */
export function defaultProfileFor(safetyClass: SafetyClass): RetryProfile {
  if (safetyClass === 'costly') return 'costly';
  if (safetyClass === 'read-safe') return 'standard';
  return 'standard';
}

export function defaultMaxAttempts(profile: RetryProfile): number {
  return PROFILES[profile].defaultMaxAttempts;
}

/**
 * Exponential backoff for the given attempt number (1-based: the delay to wait
 * BEFORE the next attempt). Returns milliseconds.
 */
export function backoffMs(profile: RetryProfile, nextAttempt: number): number {
  const spec = PROFILES[profile];
  if (spec.baseMs === 0) return 0;
  const exp = spec.baseMs * Math.pow(2, Math.max(0, nextAttempt - 1));
  const capped = Math.min(exp, spec.capMs);
  if (!spec.jitter) return capped;
  // full jitter
  return Math.floor(Math.random() * capped);
}
