import { config } from './config.js';
import type { OnboardingRun } from './types.js';

/**
 * Flag alert (spec section 09): when a step needs a human (it ran out of
 * retries, a costly step was refused, or a restart interrupted a write that is
 * not safe to repeat), tell one. Until 2026-11-11 this only wrote to the server
 * log, which nobody reads, so a stuck run sat unnoticed (one sat for two months).
 *
 * It now DMs SLACK_ALERT_USER_ID (Tyler) from the engine's Slack bot. One seam,
 * so the runner never has to know how alerts are delivered, and it never throws:
 * a failed alert must not change what happens to the step.
 */
export async function alertFlagged(run: OnboardingRun, stepKey: string, reason: string): Promise<void> {
  const who = run.client_name ?? run.id;
  console.warn(`[FLAGGED] run=${run.id} client="${who}" step=${stepKey} :: ${reason}`);
  try {
    await sendAlert(buildAlertText(run, stepKey, reason));
  } catch (err) {
    console.error(`[alert] could not send the Slack alert: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The DM text. Pure, so it can be tested. Dry runs are labeled as tests. */
export function buildAlertText(run: OnboardingRun, stepKey: string, reason: string): string {
  const who = run.client_name ?? `run ${run.id}`;
  const test = run.mode === 'dry' ? ' (dry run, nothing real was changed)' : '';
  const short = reason.length > 600 ? `${reason.slice(0, 600)}...` : reason;
  return (
    `:warning: *Onboarding Engine needs you: ${who}*${test}\n` +
    `Step \`${stepKey}\` stopped and will not retry on its own.\n` +
    `> ${short.replace(/\n+/g, ' ')}\n` +
    `<${config.publicBaseUrl()}|Open the dashboard>, find this client's run, then use *retry* on the step or *resume* on the run once the cause is fixed.`
  );
}

async function sendAlert(text: string): Promise<void> {
  const user = config.slack.alertUserId();
  if (!user) return;
  let token: string;
  try {
    token = config.slack.botToken();
  } catch {
    return; // no Slack token configured (local/dev)
  }
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ channel: user, text, mrkdwn: true, unfurl_links: false }),
    signal: AbortSignal.timeout(10000),
  });
  const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
  if (!body?.ok) throw new Error(`slack.chat.postMessage: ${body?.error ?? `HTTP ${res.status}`}`);
}
