import type { Step, StepContext } from '../../types.js';
import { callApi } from '../../lib/http.js';
import { config } from '../../config.js';
import { simulated } from './util.js';

/**
 * Warmup Inbox worker (spec section 08: warmup.enroll).
 *
 * Enrolls the client's sending inbox in Warmup Inbox so deliverability
 * ramps before live campaigns begin. Depends on mailgun.add_domain
 * because the Mailgun subdomain (mg.<domain>) must exist first.
 *
 * TODO VERIFY BEFORE LIVE USE: The Warmup Inbox REST API endpoints and
 * request/response shapes below are best-effort inferences from their
 * public documentation and common REST conventions. The exact paths,
 * field names, and authentication scheme MUST be confirmed against the
 * official Warmup Inbox API docs (https://warmupinbox.com) before this
 * step runs against a real account. Wrong endpoints will produce 404s
 * that the runner will flag after maxAttempts exhausted.
 */

const BASE = 'https://api.warmupinbox.com';

/** Auth header for every Warmup Inbox request. */
function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${config.warmup.apiKey()}` };
}

/**
 * Derive the inbox address to warm: the info@ address on the Mailgun
 * sending subdomain. Throws if the run does not have a domain yet (i.e.
 * mailgun.add_domain has not written it back, or the run is incomplete).
 */
function warmInbox(ctx: StepContext): string {
  if (!ctx.run.domain) throw new Error('warmup: run has no domain yet');
  return `info@mg.${ctx.run.domain}`;
}

// --- warmup.enroll ---

/**
 * POST /v1/inboxes to register the sending inbox with Warmup Inbox and
 * set its status to active. A 409 means the inbox is already enrolled,
 * which is a safe idempotent outcome (okStatuses tolerates it).
 *
 * TODO VERIFY: path may be /inboxes, /v1/email/inboxes, or similar.
 * TODO VERIFY: payload field names (email, status) and accepted values.
 */
async function enrollReal(ctx: StepContext): Promise<Record<string, unknown>> {
  const inbox = warmInbox(ctx);
  await callApi(ctx, `${BASE}/v1/inboxes`, 'warmup.enroll', {
    method: 'POST',
    headers: authHeaders(),
    json: { email: inbox, status: 'active' },
    okStatuses: [409], // 409 = already enrolled; treat as success
  });
  return { inbox, enrolled: true };
}

/**
 * Dry-run probe: GET /v1/inboxes?limit=1 is read-safe and confirms the
 * API key is valid without creating any resources. The enrollment result
 * is then simulated.
 *
 * TODO VERIFY: list endpoint path and query-param conventions.
 */
async function enrollDry(ctx: StepContext): Promise<Record<string, unknown>> {
  const inbox = warmInbox(ctx);
  // Read-safe probe to validate credentials before simulating the write.
  await callApi(ctx, `${BASE}/v1/inboxes?limit=1`, 'warmup.enroll.probe', {
    method: 'GET',
    headers: authHeaders(),
  });
  return simulated({ inbox, enrolled: true });
}

export const warmupSteps: Step[] = [
  {
    key: 'warmup.enroll',
    wave: 1,
    safetyClass: 'reversible-write',
    dependsOn: ['mailgun.add_domain'],
    maxAttempts: 5,
    retryProfile: 'flaky',
    isApplicable: () => true,
    runReal: enrollReal,
    runDry: enrollDry,
  },
];
