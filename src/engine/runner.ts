import { db } from '../supabase.js';
import { getStep } from '../steps/registry.js';
import { redact } from '../redact.js';
import { backoffMs, defaultProfileFor } from './retry.js';
import { loadStep, promoteDependents } from './runs.js';
import { alertFlagged } from '../alerts.js';
import { getRunMode, isDryOverridden } from '../config.js';
import { config } from '../config.js';
import type { OnboardingRun, RunStep, StepContext, StepEventInput, StepStatus } from '../types.js';

export interface JobRow {
  id: string;
  run_id: string;
  step_key: string;
  status: string;
  attempts: number;
}

const SATISFIED: ReadonlySet<StepStatus> = new Set<StepStatus>(['succeeded', 'simulated', 'skipped']);
const BROKEN: ReadonlySet<StepStatus> = new Set<StepStatus>(['failed', 'flagged', 'blocked']);
const TERMINAL: ReadonlySet<StepStatus> = new Set<StepStatus>(['succeeded', 'simulated', 'skipped']);

/**
 * Process one claimed job (spec section 09, runner algorithm).
 * Always resolves the job to 'done' or 'failed', or requeues it for retry.
 */
export async function processJob(job: JobRow): Promise<void> {
  const run = await loadRun(job.run_id);
  if (!run) {
    await finishJob(job.id, 'failed');
    return;
  }

  const stepRow = await loadStep(job.run_id, job.step_key);
  const stepDef = getStep(job.step_key);

  // Unknown step definition -> flag, don't strand the job.
  if (!stepRow || !stepDef) {
    if (stepRow) await setStepStatus(stepRow.id, 'flagged', 'No registered step definition');
    await finishJob(job.id, 'failed');
    return;
  }

  // 1. Already terminal -> no-op.
  if (TERMINAL.has(stepRow.status)) {
    await finishJob(job.id, 'done');
    return;
  }

  // 2. Not applicable -> skipped (dependency treated as satisfied).
  if (!stepDef.isApplicable(run)) {
    await setStepStatus(stepRow.id, 'skipped');
    await finishJob(job.id, 'done');
    await promoteDependents(run.id, stepRow.step_key);
    return;
  }

  // 3. Dependency check (safety net; deps are normally satisfied before enqueue).
  const depState = await evaluateDependencies(run.id, stepRow.depends_on);
  if (depState === 'broken') {
    await setStepStatus(stepRow.id, 'blocked', 'A dependency failed or is blocked');
    await finishJob(job.id, 'done');
    return;
  }
  if (depState === 'pending') {
    await requeue(job, stepRow, 5000); // wait and re-check
    return;
  }

  // 4. Mark running, increment attempts, write an info event.
  const attempt = stepRow.attempts + 1;
  const mode = run.mode ?? getRunMode();
  await db().from('run_steps').update({ status: 'running', attempts: attempt, updated_at: nowIso() })
    .eq('id', stepRow.id);

  const logEvent = makeLogger(run.id, stepRow.step_key, attempt, mode);
  const ctx: StepContext = { run, step: { ...stepRow, attempts: attempt }, mode, attempt, logEvent };

  // Pinned-dry override: even in live mode, some step keys (e.g. the domain
  // stack: namecheap/dns/mailgun/warmup) can be forced to dry via env or the
  // dashboard. Lets the team go live for everything else while keeping the
  // money/downstream-of-money steps simulated until they're explicitly ready.
  const pinnedDry = isDryOverridden(stepRow.step_key);
  const effectiveMode = pinnedDry ? 'dry' : mode;
  await logEvent({
    level: 'info',
    endpoint: `runner://${stepRow.step_key}`,
    request: { mode: effectiveMode, attempt, class: stepDef.safetyClass, ...(pinnedDry && mode === 'live' ? { pinned_dry: true } : {}) },
  });

  // 5. Pick the execution path by mode + safety class (spec section 09, step 5).
  const started = Date.now();
  try {
    let output: Record<string, unknown>;
    let finalStatus: StepStatus;

    if (stepDef.safetyClass === 'read-safe') {
      output = await stepDef.runReal(ctx);          // runs for real in both modes
      finalStatus = 'succeeded';
    } else if (effectiveMode === 'dry') {
      output = await stepDef.runDry(ctx);            // probe + simulate
      finalStatus = 'simulated';
    } else if (stepDef.safetyClass === 'costly') {
      // live + costly -> two-key unlock or refuse (spec section 04).
      const unlock = costlyUnlock(run);
      if (!unlock.ok) {
        await logEvent({ level: 'error', parsed_error: unlock.reason });
        await setStepStatus(stepRow.id, 'flagged', unlock.reason);
        await finishJob(job.id, 'failed');
        await alertFlagged(run, stepRow.step_key, unlock.reason);
        await promoteDependents(run.id, stepRow.step_key);
        return;
      }
      output = await stepDef.runReal(ctx);
      finalStatus = 'succeeded';
    } else {
      // live + reversible-write
      output = await stepDef.runReal(ctx);
      finalStatus = 'succeeded';
    }

    const duration = Date.now() - started;
    await logEvent({ level: 'info', endpoint: `runner://${stepRow.step_key}`, response_status: 200, response_body: output, duration_ms: duration });
    await db().from('run_steps').update({ status: finalStatus, output_json: output, last_error: null, updated_at: nowIso() })
      .eq('id', stepRow.id);
    await finishJob(job.id, 'done');
    // TODO (M2+): live success mirrors completion to ClickUp (spec section 13).
    await promoteDependents(run.id, stepRow.step_key);
  } catch (err) {
    const duration = Date.now() - started;
    const message = err instanceof Error ? err.message : String(err);
    await logEvent({ level: 'error', endpoint: `runner://${stepRow.step_key}`, parsed_error: message, duration_ms: duration });

    const maxAttempts = stepRow.max_attempts;
    const profile = stepDef.retryProfile ?? defaultProfileFor(stepDef.safetyClass);

    if (attempt < maxAttempts) {
      // 6a. Retry: push the job into the future, back to queued (spec section 09).
      const delay = backoffMs(profile, attempt);
      await db().from('run_steps').update({ status: 'pending', last_error: message, updated_at: nowIso() })
        .eq('id', stepRow.id);
      await requeue(job, stepRow, delay);
    } else {
      // 6b. Terminal failure: flag, alert, block dependents (spec section 09).
      await setStepStatus(stepRow.id, 'flagged', message);
      await finishJob(job.id, 'failed');
      await alertFlagged(run, stepRow.step_key, message);
      await promoteDependents(run.id, stepRow.step_key); // flips pending dependents to blocked
    }
  }
}

// --- helpers ---

type DepState = 'ready' | 'pending' | 'broken';

async function evaluateDependencies(runId: string, deps: string[]): Promise<DepState> {
  if (!deps || deps.length === 0) return 'ready';
  const { data, error } = await db().from('run_steps').select('step_key, status').eq('run_id', runId).in('step_key', deps);
  if (error || !data) throw new Error(`evaluateDependencies: ${error?.message}`);
  const statuses = data.map((r) => r.status as StepStatus);
  if (statuses.length < deps.length) return 'pending'; // some dep row not found yet
  if (statuses.some((s) => BROKEN.has(s))) return 'broken';
  if (statuses.every((s) => SATISFIED.has(s))) return 'ready';
  return 'pending';
}

function costlyUnlock(run: OnboardingRun): { ok: true } | { ok: false; reason: string } {
  // Two-key unlock: provider live flag AND a per-run confirmation token (spec section 04).
  if (!config.namecheap.live) {
    return { ok: false, reason: 'Costly step refused: NAMECHEAP_LIVE is not true' };
  }
  const token = (run.raw_intake_json?.namecheap_confirm_token ?? '') as string;
  if (!token) {
    return { ok: false, reason: 'Costly step refused: missing per-run confirmation token' };
  }
  return { ok: true };
}

async function loadRun(runId: string): Promise<OnboardingRun | null> {
  const { data, error } = await db().from('onboarding_runs').select('*').eq('id', runId).maybeSingle();
  if (error) throw new Error(`loadRun: ${error.message}`);
  return (data as OnboardingRun) ?? null;
}

async function setStepStatus(stepId: string, status: StepStatus, lastError?: string): Promise<void> {
  const patch: Record<string, unknown> = { status, updated_at: nowIso() };
  if (lastError !== undefined) patch.last_error = lastError;
  await db().from('run_steps').update(patch).eq('id', stepId);
}

async function finishJob(jobId: string, status: 'done' | 'failed'): Promise<void> {
  await db().from('jobs').update({ status }).eq('id', jobId);
}

async function requeue(job: JobRow, _step: RunStep, delayMs: number): Promise<void> {
  const runAfter = new Date(Date.now() + Math.max(0, delayMs)).toISOString();
  await db().from('jobs').update({ status: 'queued', run_after: runAfter, claimed_at: null }).eq('id', job.id);
}

function makeLogger(runId: string, stepKey: string, attempt: number, mode: string) {
  return async (event: StepEventInput): Promise<void> => {
    const row = {
      run_id: runId,
      step_key: stepKey,
      attempt,
      level: event.level ?? 'info',
      mode,
      endpoint: event.endpoint ?? null,
      request_redacted: event.request === undefined ? null : redact(event.request),
      response_status: event.response_status ?? null,
      response_body: event.response_body === undefined ? null : redact(event.response_body),
      parsed_error: event.parsed_error ?? null,
      duration_ms: event.duration_ms ?? null,
    };
    const { error } = await db().from('step_events').insert(row);
    if (error) {
      // Never let logging failures crash a step; surface to stderr only.
      console.error(`step_events insert failed for ${runId}/${stepKey}: ${error.message}`);
    }
  };
}

function nowIso(): string {
  return new Date().toISOString();
}
