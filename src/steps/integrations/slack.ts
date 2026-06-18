import type { Step, StepContext } from '../../types.js';
import { db } from '../../supabase.js';
import { callApi } from '../../lib/http.js';
import { config } from '../../config.js';
import { profileOf, simId, simulated, slugifyChannel } from './util.js';

/**
 * Slack workers (spec section 11): create the client channel, post the sale
 * summary, and post the human-readable profile + a pinned client-profile.json
 * (non-sensitive only). reversible-write: simulated in dry-run.
 *
 * Slack's Web API returns HTTP 200 with {ok:false,error} on failure, so we check
 * the body and throw to engage the runner's retry/flag path.
 */
const SLACK = 'https://slack.com/api';

function authHeader(): Record<string, string> {
  return { authorization: `Bearer ${config.slack.botToken()}` };
}

async function slackPost<T = any>(ctx: StepContext, method: string, payload: unknown): Promise<T> {
  const res = await callApi<any>(ctx, `${SLACK}/${method}`, `slack.${method}`, {
    method: 'POST',
    headers: authHeader(),
    json: payload,
  });
  if (!res.body?.ok) throw new Error(`slack.${method}: ${res.body?.error ?? 'unknown error'}`);
  return res.body as T;
}

/** Dry-run auth probe: read-safe auth.test confirms the token works. */
async function authProbe(ctx: StepContext): Promise<void> {
  const res = await callApi<any>(ctx, `${SLACK}/auth.test`, 'slack.auth.test', {
    method: 'POST',
    headers: authHeader(),
  });
  if (!res.body?.ok) throw new Error(`slack.auth.test: ${res.body?.error ?? 'auth failed'}`);
}

async function channelId(ctx: StepContext): Promise<string> {
  const id = ctx.run.slack_channel_id as string | undefined;
  if (!id) throw new Error('slack: channel id not set (create_channel must run first)');
  return id;
}

// --- create_channel ---
async function createChannelReal(ctx: StepContext): Promise<Record<string, unknown>> {
  const name = slugifyChannel((ctx.run.client_name as string) || ctx.run.id);
  const res = await slackPost<any>(ctx, 'conversations.create', { name });
  const id = res.channel.id as string;
  await db().from('onboarding_runs').update({ slack_channel_id: id, updated_at: new Date().toISOString() }).eq('id', ctx.run.id);
  return { channel_id: id, name };
}
async function createChannelDry(ctx: StepContext): Promise<Record<string, unknown>> {
  await authProbe(ctx);
  const name = slugifyChannel((ctx.run.client_name as string) || ctx.run.id);
  return simulated({ channel_id: simId('C'), name });
}

// --- post_sale_summary ---
function saleSummaryText(ctx: StepContext): string {
  const p = profileOf(ctx.run);
  const lines = [
    `*New client onboarding: ${p.office_name ?? ctx.run.client_name ?? 'Unknown'}*`,
    p.package ? `• Package: ${p.package}` : '',
    p.invoice_amount ? `• Invoice: ${p.invoice_amount}` : '',
    p.contract_length ? `• Contract: ${p.contract_length}` : '',
    p.start_date ? `• Start: ${p.start_date}` : '',
    p.client_specialty ? `• Specialty: ${p.client_specialty}` : '',
    p.special_additions ? `• Promised: ${p.special_additions}` : '',
    p.website_url ? `• Website: ${p.website_url}` : '',
  ].filter(Boolean);
  return lines.join('\n');
}
async function postSaleSummaryReal(ctx: StepContext): Promise<Record<string, unknown>> {
  const res = await slackPost<any>(ctx, 'chat.postMessage', { channel: await channelId(ctx), text: saleSummaryText(ctx), mrkdwn: true });
  return { ts: res.ts };
}
async function postSaleSummaryDry(ctx: StepContext): Promise<Record<string, unknown>> {
  await authProbe(ctx);
  return simulated({ ts: simId('ts'), preview: saleSummaryText(ctx) });
}

// --- post profile + pinned JSON ---
function profileMessage(ctx: StepContext): { text: string; json: string } {
  const p = profileOf(ctx.run);
  const human = ['*Client profile*', ...Object.entries(p).map(([k, v]) => `• ${k}: ${v}`)].join('\n');
  const json = JSON.stringify(p, null, 2); // non-sensitive only (profileOf excludes _restricted)
  return { text: `${human}\n\n\`\`\`client-profile.json\n${json}\n\`\`\``, json };
}
async function postProfileReal(ctx: StepContext): Promise<Record<string, unknown>> {
  const ch = await channelId(ctx);
  const { text, json } = profileMessage(ctx);
  const res = await slackPost<any>(ctx, 'chat.postMessage', { channel: ch, text, mrkdwn: true });
  // Pin the profile message so it's the canonical machine-readable record in-channel.
  try {
    await slackPost(ctx, 'pins.add', { channel: ch, timestamp: res.ts });
  } catch (err) {
    await ctx.logEvent({ level: 'warn', endpoint: 'slack.pins.add', parsed_error: err instanceof Error ? err.message : String(err) });
  }
  return { ts: res.ts, profile_bytes: json.length };
}
async function postProfileDry(ctx: StepContext): Promise<Record<string, unknown>> {
  await authProbe(ctx);
  const { json } = profileMessage(ctx);
  return simulated({ ts: simId('ts'), profile_bytes: json.length });
}

export const slackSteps: Step[] = [
  {
    key: 'slack.create_channel', wave: 1, safetyClass: 'reversible-write', dependsOn: [], maxAttempts: 3,
    isApplicable: () => true, runReal: createChannelReal, runDry: createChannelDry,
  },
  {
    key: 'slack.post_sale_summary', wave: 1, safetyClass: 'reversible-write',
    dependsOn: ['slack.create_channel', 'profile.normalize_intake'], maxAttempts: 3,
    isApplicable: () => true, runReal: postSaleSummaryReal, runDry: postSaleSummaryDry,
  },
  {
    key: 'slack.post_intake_profile', wave: 1, safetyClass: 'reversible-write',
    dependsOn: ['slack.create_channel', 'profile.normalize_intake'], maxAttempts: 3,
    isApplicable: () => true, runReal: postProfileReal, runDry: postProfileDry,
  },
  {
    key: 'slack.post_clientform_profile', wave: 2, safetyClass: 'reversible-write',
    dependsOn: ['profile.normalize_clientform'], maxAttempts: 3,
    isApplicable: () => true, runReal: postProfileReal, runDry: postProfileDry,
  },
];
