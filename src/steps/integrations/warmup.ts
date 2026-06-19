import type { Step, StepContext } from '../../types.js';
import { callApi } from '../../lib/http.js';
import { config } from '../../config.js';
import { profileOf, restrictedOf, simulated } from './util.js';

/**
 * Warmup Inbox worker (spec section 08: warmup.enroll).
 *
 * Verified against the official Warmup Inbox OpenAPI doc:
 *   - Auth: x-api-key header (NOT bearer).
 *   - Create:  POST /v1/inboxes
 *   - Probe:   GET  /v1/inboxes
 *   - Start:   POST /v1/inboxes/{id}/start
 *   - Required body: email, password, sender_first, sender_last, plan, frequency.
 *
 * REAL-WORLD CREDENTIAL GAP (read this before live use):
 *   Creating an inbox requires the mailbox PASSWORD (or, via the advanced
 *   endpoint, OAuth tokens). Neither form asks for it - and clients should not
 *   put a mailbox password in a Google form. So this step cannot autonomously
 *   enroll a client in live mode without additional input.
 *
 *   Handling in this build:
 *     - Dry mode: probes auth (GET /v1/inboxes), returns simulated success. No
 *       credentials required - exercises connectivity for the dashboard.
 *     - Live mode: looks for warmup credentials in the run's RESTRICTED bucket
 *       (client_profile_json._restricted.warmup_password and optional overrides
 *       for warmup_email / warmup_sender_first / warmup_sender_last). If the
 *       password is absent, the step is flagged with a clear "credentials
 *       required" message so a human can POST them via the dashboard before
 *       retrying - matches the spec's "human approval / human input" pattern.
 *
 *   For Google Workspace / Microsoft 365 clients, the realistic path is the
 *   POST /v1/inboxes/advanced endpoint with OAuth tokens; that's a follow-up
 *   we can add when we know which providers MMW's clients use most often.
 */

const BASE = 'https://api.warmupinbox.com';

function authHeaders(): Record<string, string> {
  return { 'x-api-key': config.warmup.apiKey() };
}

/** Build the create-inbox payload. Throws (clearly) if a password isn't available. */
function buildCreateBody(ctx: StepContext): Record<string, unknown> {
  const profile = profileOf(ctx.run);
  const restricted = restrictedOf(ctx.run);

  const email = (restricted.warmup_email ?? profile.doctor_email ?? '').trim();
  const password = (restricted.warmup_password ?? '').trim();
  const senderFirst = (restricted.warmup_sender_first ?? profile.doctor_first_name ?? '').trim();
  const senderLast = (restricted.warmup_sender_last ?? profile.doctor_last_name ?? '').trim();

  if (!email) {
    throw new Error('warmup: no mailbox email available (need doctor_email or _restricted.warmup_email)');
  }
  if (!password) {
    throw new Error(
      'warmup: mailbox password not provided. ' +
      'Add client_profile_json._restricted.warmup_password before retrying. ' +
      '(Sensitive - belongs in the restricted bucket, never the open profile.)',
    );
  }
  if (!senderFirst || !senderLast) {
    throw new Error('warmup: sender_first / sender_last unavailable (need doctor name or _restricted overrides)');
  }

  // Defaults follow the API's example values; tune per plan/strategy later.
  return {
    email,
    password,
    sender_first: senderFirst,
    sender_last: senderLast,
    plan: config.warmup.defaultPlan(),
    frequency: {
      starting_baseline: 0,
      increase_per_day: 2,
      max_sends_per_day: 50,
      reply_rate: 30,
      strategy: 'progressive',
    },
  };
}

// --- warmup.enroll ---

/**
 * Create the inbox, then start it. 409 on create means it already exists;
 * we tolerate that and still attempt to start, which is safe to call twice.
 */
async function enrollReal(ctx: StepContext): Promise<Record<string, unknown>> {
  const body = buildCreateBody(ctx); // throws with a clear message if creds are missing
  const created = await callApi<any>(ctx, `${BASE}/v1/inboxes`, 'warmup.inboxes.create', {
    method: 'POST',
    headers: authHeaders(),
    json: body,
    okStatuses: [409], // already enrolled - safe idempotent outcome
  });

  const inboxId = created.body?.inbox_id as string | undefined;
  if (inboxId) {
    // Start the inbox; 409 = already running, safe.
    await callApi(ctx, `${BASE}/v1/inboxes/${inboxId}/start`, 'warmup.inboxes.start', {
      method: 'POST',
      headers: authHeaders(),
      okStatuses: [409],
    });
  }

  return { inbox_id: inboxId ?? null, email: body.email, plan: body.plan };
}

/**
 * Dry-run: read-safe GET /v1/inboxes to confirm the API key works. Does not
 * require the mailbox password - just exercises the auth + connectivity path.
 */
async function enrollDry(ctx: StepContext): Promise<Record<string, unknown>> {
  await callApi(ctx, `${BASE}/v1/inboxes`, 'warmup.inboxes.list', {
    method: 'GET',
    headers: authHeaders(),
  });
  const profile = profileOf(ctx.run);
  return simulated({
    email: profile.doctor_email ?? '(unknown - needs _restricted.warmup_email)',
    plan: config.warmup.defaultPlan(),
    note: 'live enrollment requires mailbox password in _restricted.warmup_password',
  });
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
