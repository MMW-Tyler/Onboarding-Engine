import type { Step, StepContext } from '../../types.js';
import { db } from '../../supabase.js';
import { callApi } from '../../lib/http.js';
import { config } from '../../config.js';
import { simulated } from './util.js';

/**
 * Warmup Inbox worker (spec section 08: warmup.enroll) - ROTATION model.
 *
 * MMW does NOT create a Warmup Inbox per client. There is a fixed pool of
 * already-warmed inboxes (configured via WARMUPINBOX_ROTATION_INBOXES). When a
 * new domain is purchased, it is filtered into one of those inboxes on a
 * rotation. So this step's job is to:
 *   1. Deterministically pick the next inbox in the rotation (round-robin by how
 *      many domains have already been assigned).
 *   2. Confirm that inbox exists and is running, and read its current score
 *      (GET /v1/inboxes - read-safe; auth is the x-api-key header).
 *   3. Record the assignment on the run so the team knows which inbox this
 *      client's domain belongs to.
 *
 * The physical "filter the domain into this inbox" step is handled in MMW's
 * existing process (Gmail/WUI side); the engine's contribution is the
 * deterministic assignment + a health check + a clear record. No inbox is
 * created and no mailbox password is needed.
 */

const BASE = 'https://api.warmupinbox.com';

interface WuiInbox {
  inbox_id: string;
  email: string;
  status: string;
  score?: number;
}

function authHeaders(): Record<string, string> {
  return { 'x-api-key': config.warmup.apiKey() };
}

/** Round-robin: pick the rotation slot by how many domains were assigned before this run. */
async function pickRotationEmail(): Promise<{ email: string; index: number; total: number }> {
  const inboxes = config.warmup.rotationInboxes();
  if (inboxes.length === 0) {
    throw new Error('warmup: no rotation inboxes configured (set WARMUPINBOX_ROTATION_INBOXES)');
  }
  const { count } = await db()
    .from('run_steps')
    .select('id', { count: 'exact', head: true })
    .eq('step_key', 'warmup.enroll')
    .in('status', ['succeeded', 'simulated']);
  const index = (count ?? 0) % inboxes.length;
  return { email: inboxes[index]!, index, total: inboxes.length };
}

/** Fetch the live inbox pool and match the chosen email (read-safe). */
async function findInbox(ctx: StepContext, email: string): Promise<WuiInbox | undefined> {
  const res = await callApi<any>(ctx, `${BASE}/v1/inboxes`, 'warmup.inboxes.list', { headers: authHeaders() });
  const items = (res.body?.items ?? []) as WuiInbox[];
  return items.find((i) => i.email?.toLowerCase() === email.toLowerCase());
}

function requireDomain(ctx: StepContext): string {
  const d = ctx.run.domain as string | undefined;
  if (!d) throw new Error('warmup: run has no domain yet');
  return d;
}

// --- warmup.enroll (assign domain to a rotation inbox) ---
async function enrollReal(ctx: StepContext): Promise<Record<string, unknown>> {
  const domain = requireDomain(ctx);
  const pick = await pickRotationEmail();
  const inbox = await findInbox(ctx, pick.email);
  if (!inbox) {
    throw new Error(`warmup: rotation inbox ${pick.email} not found in the Warmup Inbox account`);
  }
  if (inbox.status !== 'running') {
    await ctx.logEvent({ level: 'warn', endpoint: 'warmup.assign', parsed_error: `inbox ${pick.email} status is ${inbox.status}, expected running` });
  }

  // Record which warmup inbox this client's domain rotates through.
  const existing = (ctx.run.client_profile_json ?? {}) as Record<string, unknown>;
  await db().from('onboarding_runs')
    .update({ client_profile_json: { ...existing, warmup_inbox: pick.email }, updated_at: new Date().toISOString() })
    .eq('id', ctx.run.id);

  return {
    domain,
    assigned_inbox: pick.email,
    inbox_id: inbox.inbox_id,
    inbox_status: inbox.status,
    inbox_score: inbox.score ?? null,
    rotation: `${pick.index + 1}/${pick.total}`,
    note: 'Filter this domain into the assigned warmup inbox (rotation).',
  };
}

async function enrollDry(ctx: StepContext): Promise<Record<string, unknown>> {
  const domain = requireDomain(ctx);
  const pick = await pickRotationEmail();
  const inbox = await findInbox(ctx, pick.email); // read-safe, validates auth + pool
  return simulated({
    domain,
    assigned_inbox: pick.email,
    inbox_id: inbox?.inbox_id ?? null,
    inbox_status: inbox?.status ?? 'not_found',
    inbox_score: inbox?.score ?? null,
    rotation: `${pick.index + 1}/${pick.total}`,
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
