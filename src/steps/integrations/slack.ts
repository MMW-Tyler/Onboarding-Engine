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

/** Find an existing public channel by name. Walks pages until found or exhausted.
 *  Returns null on missing_scope (channels:read not granted) so the caller can
 *  fall back to the next strategy without flagging the whole run. */
async function findChannelByName(ctx: StepContext, name: string): Promise<string | null> {
  let cursor: string | undefined;
  for (let i = 0; i < 20; i++) { // safety bound; ~20k channels max
    const url =
      `${SLACK}/conversations.list?exclude_archived=true&limit=1000&types=public_channel` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    const res = await callApi<any>(ctx, url, 'slack.conversations.list', { method: 'GET', headers: authHeader() });
    if (!res.body?.ok) {
      // missing_scope: log + skip; caller will try the create path next.
      if (res.body?.error === 'missing_scope') {
        await ctx.logEvent({ level: 'warn', endpoint: 'slack.conversations.list', parsed_error: 'channels:read not granted; skipping lookup' });
        return null;
      }
      throw new Error(`slack.conversations.list: ${res.body?.error ?? 'unknown error'}`);
    }
    const hit = (res.body.channels as Array<{ id: string; name: string }>).find((c) => c.name === name);
    if (hit) return hit.id;
    cursor = res.body.response_metadata?.next_cursor || undefined;
    if (!cursor) return null;
  }
  return null;
}

/** Public channels can be joined without an invite; safe to call repeatedly. */
async function joinIfPublic(ctx: StepContext, id: string): Promise<void> {
  await callApi(ctx, `${SLACK}/conversations.join`, 'slack.conversations.join', {
    method: 'POST',
    headers: authHeader(),
    json: { channel: id },
  });
  // Ignore not-ok responses (already in channel, private, etc.); next call will surface real issues.
}

// --- create_channel (find-or-create) ---
// Order of preference, given some workspaces block bot channel creation:
//   1. The run already has slack_channel_id (e.g. Zapier passed it on the webhook).
//   2. A public channel named client-<slug> already exists; join + use it.
//   3. Try conversations.create; if the workspace allows it, great.
//   4. Flag with a clear "please create #client-<slug> and retry" message.
async function createChannelReal(ctx: StepContext): Promise<Record<string, unknown>> {
  const name = slugifyChannel((ctx.run.client_name as string) || ctx.run.id);

  // 1. Already set (Zapier or previous run).
  if (ctx.run.slack_channel_id) {
    await joinIfPublic(ctx, ctx.run.slack_channel_id as string);
    return { channel_id: ctx.run.slack_channel_id, name, source: 'preset' };
  }

  // 2. Find an existing channel by name.
  const existing = await findChannelByName(ctx, name);
  if (existing) {
    await joinIfPublic(ctx, existing);
    await db().from('onboarding_runs').update({ slack_channel_id: existing, updated_at: new Date().toISOString() }).eq('id', ctx.run.id);
    return { channel_id: existing, name, source: 'found' };
  }

  // 3. Try to create. Some workspaces restrict this; if so we flag.
  try {
    const res = await slackPost<any>(ctx, 'conversations.create', { name });
    const id = res.channel.id as string;
    await db().from('onboarding_runs').update({ slack_channel_id: id, updated_at: new Date().toISOString() }).eq('id', ctx.run.id);
    return { channel_id: id, name, source: 'created' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `slack: no existing channel named #${name} and bot cannot create one (${msg}). ` +
      `Create #${name} in Slack (or have Zapier do it) and retry this step.`,
    );
  }
}
async function createChannelDry(ctx: StepContext): Promise<Record<string, unknown>> {
  await authProbe(ctx);
  const name = slugifyChannel((ctx.run.client_name as string) || ctx.run.id);
  // Dry-run reports whether the channel would be found vs. created.
  const existing = await findChannelByName(ctx, name);
  return simulated({ channel_id: existing ?? simId('C'), name, source: existing ? 'found' : 'would_create_or_flag' });
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

// --- wave1.rollup: one post listing the created assets + their links ---------
// Replaces the redundant sale-summary / profile reposts (the Zap already posts
// the form fields). This is the team's "everything's set up" catch: each asset
// with a link, the detected website platform, and a flag on anything to review.
const W1_ASSET_STEPS = [
  'slack.create_channel',
  'hubspot.upsert',
  'clickup.clone_template',
  'clickup.master_tracker',
  'drive.create_folders',
  'ghl.provision_subaccount',
  'namecheap.purchase_domain',
  'dns.ghl_records',
  'dns.mailgun_records',
  'mailgun.add_domain',
  'warmup.enroll',
  'crawl.detect_platform',
];

function rollupEmoji(s: string | undefined): string {
  return s === 'succeeded' ? '✅' : s === 'simulated' ? '🔵' : s === 'skipped' ? '⏭️' : (s === 'flagged' || s === 'failed') ? '⚠️' : '⏳';
}

/** Slack hyperlink: renders as a clickable label instead of a raw URL. */
function link(url: string, label: string): string {
  return `<${url}|${label}>`;
}

async function wave1RollupReal(ctx: StepContext): Promise<Record<string, unknown>> {
  // Re-read the run: sibling steps wrote ids onto it after our snapshot was taken.
  const { data: run } = await db().from('onboarding_runs').select('*').eq('id', ctx.run.id).single();
  const r = (run ?? ctx.run) as Record<string, any>;
  const channel = r.slack_channel_id as string | undefined;
  if (!channel) return { posted: false, reason: 'no slack channel on run' };

  const { data: stepRows } = await db()
    .from('run_steps').select('step_key, status, output_json').eq('run_id', ctx.run.id).in('step_key', W1_ASSET_STEPS);
  const byKey = new Map((stepRows ?? []).map((s) => [s.step_key as string, s]));
  const stat = (k: string) => (byKey.get(k)?.status as string | undefined);
  const out = (k: string) => (byKey.get(k)?.output_json ?? {}) as Record<string, any>;

  const team = config.clickup.teamId();
  const profile = (r.client_profile_json ?? {}) as Record<string, any>;
  const client = r.client_name ?? 'client';

  // Build "asset — link" lines, only for assets that produced an id. Links use
  // Slack's <url|label> syntax so they render as a clickable label, not a raw URL.
  const lines: string[] = [];
  lines.push(`${rollupEmoji(stat('slack.create_channel'))}  *Slack channel*  —  this channel`);

  const companyId = (r.hubspot_company_id as string | undefined) ?? out('hubspot.upsert').company_id;
  if (companyId) {
    const portal = config.hubspot.portalId();
    const val = portal ? link(`https://app.hubspot.com/contacts/${portal}/company/${companyId}`, 'Open in HubSpot') : `id \`${companyId}\``;
    lines.push(`${rollupEmoji(stat('hubspot.upsert'))}  *HubSpot company*  —  ${val}`);
  }

  const folderId = r.clickup_folder_id as string | undefined;
  if (folderId && team) lines.push(`${rollupEmoji(stat('clickup.clone_template'))}  *ClickUp folder*  —  ${link(`https://app.clickup.com/${team}/v/f/${folderId}`, 'Open folder')}`);
  const taskId = out('clickup.master_tracker').task_id as string | undefined;
  if (taskId) lines.push(`${rollupEmoji(stat('clickup.master_tracker'))}  *ClickUp tracker*  —  ${link(`https://app.clickup.com/t/${taskId}`, 'Open task')}`);

  const driveId = r.drive_root_folder_id as string | undefined;
  if (driveId) lines.push(`${rollupEmoji(stat('drive.create_folders'))}  *Google Drive*  —  ${link(`https://drive.google.com/drive/folders/${driveId}`, 'Open Drive folder')}`);

  const locId = r.ghl_location_id as string | undefined;
  if (locId) lines.push(`${rollupEmoji(stat('ghl.provision_subaccount'))}  *GHL sub-account*  —  id \`${locId}\``);

  // Website platform check (the one piece of net-new info vs. the intake form).
  const platform = (profile.detected_platform as string | undefined) || 'unknown';
  const builder = profile.detected_wp_builder as string | undefined;
  let platformLine: string;
  if (platform === 'unknown') {
    platformLine = `⚠️  *Website platform:* unknown — confirm manually`;
  } else if (platform === 'WordPress') {
    const ready = profile.mmw_take_in_house === true;
    platformLine = `${ready ? '✅' : '⚠️'}  *Website platform:* WordPress${builder ? ` / ${builder}` : ''} ${ready ? '— Elementor, take in-house' : '— not Elementor, review'}`;
  } else {
    platformLine = `⚠️  *Website platform:* ${platform} — proprietary, refer-out / rebuild`;
  }

  // Email/domain stack is pinned dry for now; note it so no one expects it live.
  const emailKeys = ['namecheap.purchase_domain', 'dns.ghl_records', 'dns.mailgun_records', 'mailgun.add_domain', 'warmup.enroll'];
  const emailSimulated = emailKeys.every((k) => stat(k) === 'simulated' || stat(k) === undefined);

  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: `✅ Wave 1 complete — ${client}`, emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: `Account setup is done. *Wave 2* (AI research) kicks off when the Client MMW onboarding form arrives.` } },
    { type: 'divider' },
    { type: 'section', text: { type: 'mrkdwn', text: `:package: *Assets created*\n${lines.join('\n')}` } },
    { type: 'divider' },
    { type: 'section', text: { type: 'mrkdwn', text: platformLine } },
  ];
  if (emailSimulated) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '🔵 Domain + email stack simulated (pinned dry — not provisioned yet)' }] });
  }
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `OnboardEngine · run \`${r.id}\`` }] });

  // Plain-text fallback (notifications / clients that don't render blocks).
  const fallback = `Wave 1 complete — ${client}: ${lines.length} assets created.`;

  const res = await callApi<any>(ctx, `${SLACK}/chat.postMessage`, 'slack.chat.postMessage', {
    method: 'POST',
    headers: authHeader(),
    json: { channel, text: fallback, blocks },
  });
  if (!res.body?.ok) throw new Error(`slack.chat.postMessage: ${res.body?.error ?? 'unknown'}`);
  return { posted: true, ts: res.body.ts, assets: lines.length };
}

async function wave1RollupDry(ctx: StepContext): Promise<Record<string, unknown>> {
  await authProbe(ctx);
  return simulated({ posted: false, note: 'would post the Wave 1 asset roll-up to the client channel' });
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
  {
    // Posts last, after every Wave 1 asset step has finished. These are SOFT
    // deps: the roll-up waits for them to be terminal but is never blocked by a
    // failure, so it always posts and can flag whatever errored ("nice catch").
    // It does hard-depend on the channel since it has nowhere to post without it.
    key: 'slack.wave1_rollup', wave: 1, safetyClass: 'reversible-write',
    dependsOn: ['slack.create_channel'],
    softDependsOn: [
      'hubspot.upsert', 'clickup.clone_template', 'clickup.master_tracker',
      'drive.create_folders', 'ghl.provision_subaccount', 'crawl.detect_platform',
      'namecheap.purchase_domain', 'dns.ghl_records', 'dns.mailgun_records', 'mailgun.add_domain', 'warmup.enroll',
    ],
    maxAttempts: 3, isApplicable: () => true, runReal: wave1RollupReal, runDry: wave1RollupDry,
  },
];
