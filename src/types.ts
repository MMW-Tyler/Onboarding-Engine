import type { RunMode } from './config.js';

/** Spec section 04: every step carries a safety class. */
export type SafetyClass = 'read-safe' | 'reversible-write' | 'costly';

/** Retry backoff profile (spec section 09). See engine/retry.ts for the table. */
export type RetryProfile = 'flaky' | 'standard' | 'ai' | 'costly';

/** Spec section 06: run_steps.status state machine. */
export type StepStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'flagged'
  | 'blocked'
  | 'skipped'
  | 'simulated';

export type Wave = 1 | 2 | null;

export interface OnboardingRun {
  id: string;
  client_name: string | null;
  package: string | null;
  recipe: string;
  mode: RunMode;
  domain: string | null;
  phase0_complete: boolean;
  client_profile_json: Record<string, unknown> | null;
  raw_intake_json: Record<string, unknown> | null;
  raw_clientform_json: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface RunStep {
  id: string;
  run_id: string;
  step_key: string;
  wave: Wave;
  safety_class: SafetyClass;
  status: StepStatus;
  attempts: number;
  max_attempts: number;
  depends_on: string[];
  last_error: string | null;
  output_json: Record<string, unknown> | null;
  idempotency_key: string;
  clickup_task_id: string | null;
}

/**
 * Context handed to every step's runReal / runDry (spec section 09).
 * `logEvent` appends a redacted row to step_events.
 */
export interface StepContext {
  run: OnboardingRun;
  step: RunStep;
  mode: RunMode;
  attempt: number;
  logEvent: (event: StepEventInput) => Promise<void>;
}

export interface StepEventInput {
  level?: 'info' | 'warn' | 'error';
  endpoint?: string;
  request?: unknown;          // redacted before write
  response_status?: number;
  response_body?: unknown;
  parsed_error?: string;
  duration_ms?: number;
}

/**
 * The generic step contract (spec section 09).
 * read-safe steps reuse runReal for runDry (they have no irreversible effects).
 */
export interface Step {
  key: string;
  wave: Wave;
  safetyClass: SafetyClass;
  dependsOn: string[];
  /**
   * Ordering-only dependencies: the step waits until these have reached a
   * terminal state, but is NEVER blocked by their failure (unlike dependsOn).
   * Used for steps like the Wave 1 roll-up that must run last AND must still
   * run when something upstream flagged, so they can report it. Code-only
   * (resolved from the step definition by the runner); not persisted.
   */
  softDependsOn?: string[];
  maxAttempts: number;
  /** backoff profile; defaults from safetyClass when omitted */
  retryProfile?: RetryProfile;
  /** whether this step applies to the given run (recipe/package gating) */
  isApplicable: (run: OnboardingRun) => boolean;
  /** real external call */
  runReal: (ctx: StepContext) => Promise<Record<string, unknown>>;
  /** probe + simulate; read-safe steps may delegate to runReal */
  runDry: (ctx: StepContext) => Promise<Record<string, unknown>>;
}
