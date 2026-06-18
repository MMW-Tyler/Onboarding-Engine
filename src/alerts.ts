import type { OnboardingRun } from './types.js';

/**
 * Flag alert (spec section 09): when a step is flagged after exhausting retries,
 * notify a human. M1 logs to stderr; M4 wires this to the real Slack channel
 * (SLACK_FALLBACK_CHANNEL_ID or the run's channel). Kept as one seam so the
 * runner never has to know how alerts are delivered.
 */
export async function alertFlagged(run: OnboardingRun, stepKey: string, reason: string): Promise<void> {
  const who = run.client_name ?? run.id;
  console.warn(`[FLAGGED] run=${run.id} client="${who}" step=${stepKey} :: ${reason}`);
  // TODO (M4): post to Slack with a one-click rerun link.
}
