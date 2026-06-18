import type { Step, StepContext } from '../types.js';

/**
 * Fake "echo" steps for M1 (spec section 16, M1): exercise the full lifecycle
 * retry -> flag -> block -> rerun -> simulated WITHOUT touching any real service.
 *
 * Topology:
 *   echo.root  (reversible-write, no deps)
 *   echo.child (reversible-write, depends on echo.root)   <- goes `blocked` if root flags
 *   echo.leaf  (read-safe, no deps)                       <- runs for real even in dry
 *
 * Failure control: each run can carry an input budget of how many attempts an
 * echo step should fail before succeeding. We track the remaining budget in
 * memory keyed by run:step, so it survives reruns - that is what lets you watch
 *   first run  -> retries exhaust -> flagged (+ child blocked)
 *   rerun      -> remaining failures consumed -> finally succeeds
 *
 * Configure via the run input (stored in raw_intake_json), e.g.:
 *   { "echo": { "root": { "failTimes": 9 } } }
 *
 * This is test-only scaffolding; remove (or leave unused) once real steps land.
 */

const failBudget = new Map<string, number>();

function budgetKey(runId: string, stepKey: string): string {
  return `${runId}:${stepKey}`;
}

function shortName(stepKey: string): string {
  return stepKey.split('.')[1] ?? stepKey;
}

/** Read the configured failTimes for this step from the run input. */
function configuredFailTimes(ctx: StepContext): number {
  const echoCfg = (ctx.run.raw_intake_json?.echo ?? {}) as Record<string, { failTimes?: number }>;
  const n = echoCfg[shortName(ctx.step.step_key)]?.failTimes;
  return typeof n === 'number' && n > 0 ? n : 0;
}

/** Throws while there is remaining fail budget; otherwise returns a payload. */
async function echoExec(ctx: StepContext, label: string): Promise<Record<string, unknown>> {
  const key = budgetKey(ctx.run.id, ctx.step.step_key);
  if (!failBudget.has(key)) {
    failBudget.set(key, configuredFailTimes(ctx));
  }
  const remaining = failBudget.get(key) ?? 0;

  await ctx.logEvent({
    level: 'info',
    endpoint: `echo://${ctx.step.step_key}`,
    request: { label, attempt: ctx.attempt, remainingFailBudget: remaining },
  });

  if (remaining > 0) {
    failBudget.set(key, remaining - 1);
    throw new Error(`echo ${ctx.step.step_key}: simulated failure (${remaining} remaining)`);
  }

  return { ok: true, label, step: ctx.step.step_key, echoedAt: new Date().toISOString() };
}

function makeEchoStep(opts: {
  key: string;
  safetyClass: Step['safetyClass'];
  dependsOn: string[];
  maxAttempts: number;
}): Step {
  return {
    key: opts.key,
    wave: null,
    safetyClass: opts.safetyClass,
    dependsOn: opts.dependsOn,
    maxAttempts: opts.maxAttempts,
    isApplicable: () => true,
    runReal: (ctx) => echoExec(ctx, 'real'),
    // Dry path still runs the fail-budget logic so we can exercise probe failures,
    // but a clean (budget 0) reversible-write resolves to `simulated` via the runner.
    runDry: (ctx) => echoExec(ctx, 'dry'),
  };
}

export const echoSteps: Step[] = [
  makeEchoStep({ key: 'echo.root', safetyClass: 'reversible-write', dependsOn: [], maxAttempts: 3 }),
  makeEchoStep({ key: 'echo.child', safetyClass: 'reversible-write', dependsOn: ['echo.root'], maxAttempts: 3 }),
  makeEchoStep({ key: 'echo.leaf', safetyClass: 'read-safe', dependsOn: [], maxAttempts: 3 }),
];

/** Test helper: clear in-memory fail budgets (used by unit tests). */
export function _resetEchoBudget(): void {
  failBudget.clear();
}
