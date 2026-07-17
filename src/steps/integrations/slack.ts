import type { Step, StepContext } from '../../types.js';
import { db } from '../../supabase.js';
import { callApi } from '../../lib/http.js';
import { config } from '../../config.js';
import { profileOf, simId, simulated, slugifyChannel, chunkText } from './util.js';
import { SCHEMAS } from '../../profile/canonical.js';

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

export async function slackPost<T = any>(ctx: StepContext, method: string, payload: unknown): Promise<T> {
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

// Internal bookkeeping other steps write into client_profile_json (Mailgun's
// DNS record arrays, crawl's detected-platform readouts, the assigned warmup
// inbox) - useful for those steps to read back, but not "what the client
// said," so they don't belong in a summary meant for reviewing client answers.
const INTERNAL_PROFILE_KEYS = new Set([
  'mailgun_sending_dns', 'mailgun_receiving_dns',
  'detected_platform', 'detected_wp_builder', 'detected_wp_theme',
  'detected_themes', 'detected_plugins', 'detected_integrations', 'detected_fonts',
  'warmup_inbox', 'wave2_canvas_id',
]);

// --- post profile + pinned JSON ---

// Pretty label for each canonical key, pulled from the single source of truth
// (profile/canonical.ts's CanonicalKey.description) instead of a second,
// hand-maintained label list that would drift out of sync with it.
const KEY_LABELS: Record<string, string> = Object.fromEntries(
  [...SCHEMAS.intake.keys, ...SCHEMAS.clientform.keys].map((k) => [k.key, k.description]),
);
function labelFor(key: string): string {
  return KEY_LABELS[key] ?? key;
}

/**
 * Groups the profile into a scannable, sectioned summary instead of one flat
 * bullet dump in whatever order the merge happened to produce - the actual
 * "wall of text" complaint. Order is most-wanted-first. A key not listed here
 * still shows, bucketed into "Other" at the end, so nothing silently
 * disappears if a new canonical key gets added later without updating this.
 */
const PROFILE_GROUPS: { title: string; emoji: string; keys: string[] }[] = [
  { title: 'Practice', emoji: '🏥', keys: [
    'office_name', 'legal_business_name', 'client_specialty', 'package',
    'contract_length', 'start_date', 'invoice_amount', 'special_additions', 'book_to_mail',
  ] },
  { title: 'Point of contact', emoji: '👤', keys: [
    'doctor_first_name', 'doctor_last_name', 'doctor_email', 'doctor_mobile',
    'office_manager_name', 'office_manager_email', 'point_person', 'contact_phone', 'contact_email',
  ] },
  { title: 'Location', emoji: '📍', keys: [
    'nap_address', 'nap_street', 'nap_city', 'nap_state', 'nap_zip', 'nap_phone', 'nap_email', 'other_locations',
  ] },
  { title: 'Online presence', emoji: '🌐', keys: [
    'website_url', 'website_build_type', 'website_build_notes',
    'youtube_url', 'facebook_url', 'instagram_url', 'linkedin_url',
  ] },
  { title: 'Marketing & positioning', emoji: '🎯', keys: [
    'usp_reason', 'focus_services', 'ideal_patient', 'differentiators', 'credentials', 'providers', 'goals_12mo',
  ] },
  { title: 'Business details', emoji: '📊', keys: [
    'monthly_revenue', 'lifetime_patient_value', 'insurance_vs_cash', 'financing_options',
    'year_founded', 'geo_targets', 'office_hours', 'email_count', 'chamber_of_commerce',
    'licensed_states', 'years_experience',
  ] },
  { title: 'Personal & story', emoji: '💬', keys: [
    'hobbies', 'birthdays', 'undergrad', 'residency', 'medical_school', 'community_groups',
  ] },
  { title: 'Program terms', emoji: '📝', keys: ['agreement_ack', 'referral_interest', 'referral_doctors'] },
  { title: 'Submission', emoji: '🕓', keys: ['submitted_at'] },
];

/** A group's rendered text can occasionally exceed Slack's ~3000-char
 *  per-block limit (a long narrative answer); split into multiple blocks. */
function sectionBlocksFor(header: string, lines: string[]): unknown[] {
  const body = lines.join('\n');
  if (`${header}\n${body}`.length <= 2900) {
    return [{ type: 'section', text: { type: 'mrkdwn', text: `${header}\n${body}` } }];
  }
  const parts = chunkText(body, 2800);
  return parts.map((text, i) => ({
    type: 'section',
    text: { type: 'mrkdwn', text: i === 0 ? `${header}\n${text}` : `_${header.replace(/\*/g, '')} (cont'd)_\n${text}` },
  }));
}

/** Group + render the profile into Block Kit sections, mirroring the Wave 1
 *  roll-up's visual style, instead of one flat, hard-to-scan bullet list. */
function groupedProfileBlocks(p: Record<string, string>): unknown[] {
  const used = new Set<string>();
  const blocks: unknown[] = [];

  for (const group of PROFILE_GROUPS) {
    const lines = group.keys
      .filter((k) => p[k] != null)
      .map((k) => { used.add(k); return `• *${labelFor(k)}:* ${p[k]}`; });
    if (lines.length === 0) continue;
    blocks.push(...sectionBlocksFor(`${group.emoji} *${group.title}*`, lines));
  }

  const leftoverKeys = Object.keys(p).filter((k) => !used.has(k));
  if (leftoverKeys.length > 0) {
    const lines = leftoverKeys.map((k) => `• *${labelFor(k)}:* ${p[k]}`);
    blocks.push(...sectionBlocksFor('🗂️ *Other*', lines));
  }

  return blocks;
}

/** JSON code block, also split defensively for very large profiles. */
function jsonBlocks(json: string): unknown[] {
  if (json.length <= 2800) {
    return [{ type: 'section', text: { type: 'mrkdwn', text: `\`\`\`client-profile.json\n${json}\n\`\`\`` } }];
  }
  const parts = chunkText(json, 2700);
  return parts.map((part, i) => ({
    type: 'section',
    text: { type: 'mrkdwn', text: `\`\`\`client-profile.json${parts.length > 1 ? ` (part ${i + 1}/${parts.length})` : ''}\n${part}\n\`\`\`` },
  }));
}

function profileMessage(ctx: StepContext): { blocks: unknown[]; fallback: string; json: string } {
  const p = profileOf(ctx.run);
  const clientAnswers = Object.fromEntries(Object.entries(p).filter(([k]) => !INTERNAL_PROFILE_KEYS.has(k)));
  const json = JSON.stringify(clientAnswers, null, 2); // non-sensitive, client-answer fields only
  const client = (ctx.run.client_name as string | undefined) ?? clientAnswers.office_name ?? 'client';

  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: `📋 Client profile — ${client}`, emoji: true } },
    ...groupedProfileBlocks(clientAnswers),
    { type: 'divider' },
    ...jsonBlocks(json),
  ];
  return { blocks, fallback: `Client profile — ${client}`, json };
}
async function postProfileReal(ctx: StepContext): Promise<Record<string, unknown>> {
  const ch = await channelId(ctx);
  const { blocks, fallback, json } = profileMessage(ctx);
  const res = await slackPost<any>(ctx, 'chat.postMessage', { channel: ch, text: fallback, blocks, mrkdwn: true });
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
  'mailgun.verify',
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

/** Join a list for display, capping length so the roll-up stays tidy. */
function capList(items: unknown, max: number): string {
  const arr = (Array.isArray(items) ? items : []).map((x) => String(x)).filter(Boolean);
  if (arr.length === 0) return '';
  const shown = arr.slice(0, max).join(', ');
  return arr.length > max ? `${shown} (+${arr.length - max} more)` : shown;
}

/**
 * Build the "Website" block: a platform/builder headline (with MMW's
 * take-in-house vs refer-out call) plus the tech fingerprint the crawl pulled
 * from the homepage (theme(s), plugins & tools, integrations, fonts).
 */
function websiteSection(profile: Record<string, any>): string {
  const platform = (profile.detected_platform as string | undefined) || 'unknown';
  const builder = profile.detected_wp_builder as string | undefined;

  let head: string;
  if (platform === 'unknown') {
    head = `⚠️  *Website:* platform unknown — confirm manually`;
  } else if (platform === 'WordPress') {
    const ready = profile.mmw_take_in_house === true;
    head = `${ready ? '✅' : '⚠️'}  *Website:* WordPress${builder ? ` / ${builder}` : ''} ${ready ? '— Elementor, take in-house' : '— not Elementor, review'}`;
  } else {
    head = `⚠️  *Website:* ${platform} — proprietary, refer-out / rebuild`;
  }

  // Merge plugin-path detections with third-party integration matches, deduped.
  const tools: string[] = [];
  const seen = new Set<string>();
  for (const t of [...(profile.detected_plugins ?? []), ...(profile.detected_integrations ?? [])]) {
    const key = String(t).toLowerCase();
    if (!seen.has(key)) { seen.add(key); tools.push(String(t)); }
  }

  const detail: string[] = [];
  const themes = capList(profile.detected_themes, 3);
  if (themes) detail.push(`     • Theme: ${themes}`);
  const toolsLine = capList(tools, 12);
  if (toolsLine) detail.push(`     • Plugins & tools: ${toolsLine}`);
  const fonts = capList(profile.detected_fonts, 8);
  if (fonts) detail.push(`     • Fonts: ${fonts}`);

  return detail.length ? `${head}\n${detail.join('\n')}` : head;
}

/** Load the run row + Wave 1 step rows for the roll-up. */
async function loadRollupData(runId: string): Promise<{ r: Record<string, any>; byKey: Map<string, any> }> {
  const { data: run } = await db().from('onboarding_runs').select('*').eq('id', runId).single();
  const { data: stepRows } = await db()
    .from('run_steps').select('step_key, status, output_json, last_error').eq('run_id', runId).in('step_key', W1_ASSET_STEPS);
  const byKey = new Map((stepRows ?? []).map((s) => [s.step_key as string, s]));
  return { r: (run ?? { id: runId }) as Record<string, any>, byKey };
}

interface Wave1Content {
  client: string;
  assetLines: string[];
  platformLine: string;
  stackLines: string[];
  allStackSimulated: boolean;
}

/**
 * Build the roll-up content. `asLinks` controls link rendering: true uses Slack's
 * <url|label> syntax for an API-posted message; false emits raw URLs for a
 * copy-paste message (typed Slack text auto-links raw URLs but does NOT render
 * <url|label>). *bold*, `code`, and emoji render the same either way.
 */
function buildWave1Content(r: Record<string, any>, byKey: Map<string, any>, asLinks: boolean): Wave1Content {
  const stat = (k: string) => (byKey.get(k)?.status as string | undefined);
  const out = (k: string) => (byKey.get(k)?.output_json ?? {}) as Record<string, any>;
  const err = (k: string) => (byKey.get(k)?.last_error as string | undefined);
  const val = (url: string, label: string) => (asLinks ? link(url, label) : url);

  const team = config.clickup.teamId();
  const profile = (r.client_profile_json ?? {}) as Record<string, any>;
  const client = r.client_name ?? 'client';

  const assetLines: string[] = [];
  assetLines.push(`${rollupEmoji(stat('slack.create_channel'))}  *Slack channel*  —  ${asLinks ? 'this channel' : 'created'}`);

  const companyId = (r.hubspot_company_id as string | undefined) ?? out('hubspot.upsert').company_id;
  if (companyId) {
    const portal = config.hubspot.portalId();
    const v = portal ? val(`https://app.hubspot.com/contacts/${portal}/company/${companyId}`, 'Open in HubSpot') : `id ${companyId}`;
    assetLines.push(`${rollupEmoji(stat('hubspot.upsert'))}  *HubSpot company*  —  ${v}`);
  }

  const folderId = r.clickup_folder_id as string | undefined;
  if (folderId && team) assetLines.push(`${rollupEmoji(stat('clickup.clone_template'))}  *ClickUp folder*  —  ${val(`https://app.clickup.com/${team}/v/f/${folderId}`, 'Open folder')}`);
  const taskId = out('clickup.master_tracker').task_id as string | undefined;
  if (taskId) assetLines.push(`${rollupEmoji(stat('clickup.master_tracker'))}  *ClickUp tracker*  —  ${val(`https://app.clickup.com/t/${taskId}`, 'Open task')}`);

  const driveId = r.drive_root_folder_id as string | undefined;
  if (driveId) assetLines.push(`${rollupEmoji(stat('drive.create_folders'))}  *Google Drive*  —  ${val(`https://drive.google.com/drive/folders/${driveId}`, 'Open Drive folder')}`);

  const locId = r.ghl_location_id as string | undefined;
  if (locId) assetLines.push(`${rollupEmoji(stat('ghl.provision_subaccount'))}  *GHL sub-account*  —  ${val(`https://app.medicalmarketingwhiz.com/v2/location/${locId}/dashboard`, 'Open in GHL')}`);

  const platformLine = websiteSection(profile);

  // Domain to reference in the human notes: the purchased one if we have it.
  const purchasedDomain = (out('namecheap.purchase_domain').domain as string | undefined) || (r.domain as string | undefined) || '';
  const brandedHost = config.ghl.brandedDns().host || 'go';
  const assignedInbox = profile.warmup_inbox as string | undefined;
  const done = (s: string | undefined) => s === 'succeeded' || s === 'simulated';

  const STACK: [string, string][] = [
    ['namecheap.purchase_domain', 'Domain purchase'],
    ['mailgun.add_domain', 'Mailgun sending domain'],
    ['dns.mailgun_records', 'DNS (Mailgun records)'],
    ['dns.ghl_records', 'DNS (GHL branded)'],
    ['mailgun.verify', 'Mailgun verification'],
    ['warmup.enroll', 'Inbox warmup'],
  ];
  const stackLines: string[] = [];
  for (const [k, label] of STACK) {
    const s = stat(k);
    let line = `${rollupEmoji(s)}  ${label}`;
    if (k === 'namecheap.purchase_domain' && s === 'succeeded' && out(k).domain) line += `: \`${out(k).domain}\``;
    if (k === 'mailgun.verify' && s === 'succeeded') line += `: ${out(k).verified ? 'verified' : `${out(k).state ?? 'pending'} (propagating)`}`;
    if ((s === 'flagged' || s === 'failed') && err(k)) line += ` — ${err(k)}`;
    stackLines.push(line);

    // Plain-English action notes so the whole team knows what to do next.
    if (k === 'dns.ghl_records' && done(s) && purchasedDomain) {
      stackLines.push(`        ↳ *Action:* the branded domain is *${brandedHost}.${purchasedDomain}*. In this client's GHL sub-account go to *Settings → Business Profile* and add *${brandedHost}.${purchasedDomain}* as the branded domain.`);
    }
    if (k === 'warmup.enroll' && done(s)) {
      const inbox = assignedInbox ? `*${assignedInbox}*` : 'the assigned inbox';
      stackLines.push(`        ↳ *Action:* the engine picked the next inbox in the rotation: ${inbox}. Attach *${purchasedDomain || 'the new domain'}* to it by opening this run in the dashboard and clicking *Warmup setup* for the SMTP values to paste in.`);
    }
  }
  const allStackSimulated = STACK.every(([k]) => stat(k) === 'simulated' || stat(k) === undefined);

  return { client, assetLines, platformLine, stackLines, allStackSimulated };
}

/**
 * Plain-text roll-up for copy-paste into Slack (used when a run has no channel
 * to auto-post to). Raw URLs + *bold* + emoji render correctly when pasted.
 */
export async function buildWave1RollupText(runId: string): Promise<string> {
  const { r, byKey } = await loadRollupData(runId);
  const c = buildWave1Content(r, byKey, false);
  return [
    `✅ Wave 1 complete — ${c.client}`,
    `Account setup is done. Lines marked "↳ Action" need a quick human step. Wave 2 (AI research) kicks off when the Client MMW onboarding form arrives.`,
    ``,
    `📦 Assets created`,
    ...c.assetLines,
    ``,
    c.platformLine,
    ``,
    `🌐 Domain & email stack${c.allStackSimulated ? ' (simulated — pinned dry)' : ''}`,
    ...c.stackLines,
    ``,
    `OnboardEngine · run ${r.id}`,
  ].join('\n');
}

async function wave1RollupReal(ctx: StepContext): Promise<Record<string, unknown>> {
  // Re-read the run: sibling steps wrote ids onto it after our snapshot was taken.
  const { r, byKey } = await loadRollupData(ctx.run.id);
  const channel = r.slack_channel_id as string | undefined;
  if (!channel) return { posted: false, reason: 'no slack channel on run' };

  const c = buildWave1Content(r, byKey, true);
  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: `✅ Wave 1 complete — ${c.client}`, emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: `Account setup is done. Lines marked *↳ Action* need a quick human step. *Wave 2* (AI research) kicks off when the Client MMW onboarding form arrives.` } },
    { type: 'divider' },
    { type: 'section', text: { type: 'mrkdwn', text: `:package: *Assets created*\n${c.assetLines.join('\n')}` } },
    { type: 'divider' },
    { type: 'section', text: { type: 'mrkdwn', text: c.platformLine } },
    { type: 'divider' },
    { type: 'section', text: { type: 'mrkdwn', text: `:globe_with_meridians: *Domain & email stack*${c.allStackSimulated ? ' _(simulated — pinned dry)_' : ''}\n${c.stackLines.join('\n')}` } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `OnboardEngine · run \`${r.id}\`` }] },
  ];
  const fallback = `Wave 1 complete — ${c.client}: ${c.assetLines.length} assets.`;

  const res = await callApi<any>(ctx, `${SLACK}/chat.postMessage`, 'slack.chat.postMessage', {
    method: 'POST',
    headers: authHeader(),
    json: { channel, text: fallback, blocks },
  });
  if (!res.body?.ok) throw new Error(`slack.chat.postMessage: ${res.body?.error ?? 'unknown'}`);
  return { posted: true, ts: res.body.ts, assets: c.assetLines.length };
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
      'namecheap.purchase_domain', 'dns.ghl_records', 'dns.mailgun_records', 'mailgun.add_domain', 'mailgun.verify', 'warmup.enroll',
    ],
    maxAttempts: 3, isApplicable: () => true, runReal: wave1RollupReal, runDry: wave1RollupDry,
  },
];
