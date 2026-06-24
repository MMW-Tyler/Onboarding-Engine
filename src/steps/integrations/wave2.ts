import type { Step, StepContext } from '../../types.js';
import { db } from '../../supabase.js';
import { callApi } from '../../lib/http.js';
import { config } from '../../config.js';
import { draft, loadPromptSystem } from '../../lib/anthropic.js';
import { searchPlace } from '../../lib/places.js';
import { profileOf, siblingOutput, simulated } from './util.js';
import { toHost } from '../../lib/domain.js';

/**
 * Wave 2 AI research + rollup (spec section 08/14, Prompts 3-6). All AI steps are
 * read-safe (they run for real in dry too): they gather data, generate a DRAFT
 * via Claude, and store it on the step output for human review. wave2.rollup
 * (reversible-write) posts a review summary to the client's Slack channel.
 *
 * Drafts are stored in output_json (visible in the dashboard). Saving each draft
 * to its Drive folder is a future enhancement; the rollup is the review surface.
 */
const SLACK = 'https://slack.com/api';

function pick(p: Record<string, string>, keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) if (p[k]) out[k] = p[k]!;
  return out;
}

// --- Prompt 3: GBP optimization plan -----------------------------------------
async function gbpOptimizePlan(ctx: StepContext): Promise<Record<string, unknown>> {
  const p = profileOf(ctx.run);
  const queryParts = [p.office_name, p.nap_address, p.nap_street, p.nap_city, p.nap_state].filter(Boolean);
  if (queryParts.length === 0) {
    throw new Error('GBP: no name/address available to look up the practice (flag for AE)');
  }
  const place = await searchPlace(queryParts.join(', '));
  // Guardrail (spec Prompt 3): no Places match -> do NOT call the API, flag instead.
  if (!place) {
    await ctx.logEvent({ level: 'warn', endpoint: 'gbp.optimize_plan', parsed_error: 'GBP not found - no Places match' });
    throw new Error('GBP not found: no Google Places match for this practice (flag for AE)');
  }
  const system = loadPromptSystem('03-gbp-optimize-plan.md');
  const user =
    `PLACES_RECORD: ${JSON.stringify(place)}\n` +
    `CLIENT_PROFILE: ${JSON.stringify(pick(p, ['nap_address', 'nap_street', 'nap_city', 'nap_state', 'nap_phone', 'focus_services', 'geo_targets', 'differentiators', 'credentials', 'providers']))}`;
  const text = await draft({ systemText: system, userText: user });
  return { place_id: place.id, place_name: place.name, draft: text };
}

// --- Prompt 4: crawl -> brand + SEO report -----------------------------------
interface CrawledPage { url: string; title: string; meta: string; h1: string; word_count: number }

async function crawlSite(ctx: StepContext, host: string): Promise<{ pages: CrawledPage[]; nav: string[] }> {
  const base = `https://${host}`;
  const fetchPage = async (url: string): Promise<{ html: string } | null> => {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 12000);
      const res = await fetch(url, { redirect: 'follow', signal: controller.signal, headers: { 'user-agent': 'OnboardEngine/1.0 crawler' } }).finally(() => clearTimeout(t));
      if (!res.ok) return null;
      return { html: (await res.text()).slice(0, 400_000) };
    } catch { return null; }
  };
  const home = await fetchPage(base);
  if (!home) return { pages: [], nav: [] };

  // Discover a handful of internal links from the homepage.
  const links = new Set<string>();
  const re = /href="([^"#]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(home.html)) && links.size < 12) {
    let href = m[1]!;
    if (href.startsWith('/')) href = base + href;
    if (href.startsWith(base) && !/\.(png|jpe?g|gif|svg|pdf|css|js|webp|ico)(\?|$)/i.test(href)) links.add(href.split('#')[0]!);
  }
  const targets = [base, ...[...links].filter((l) => l !== base).slice(0, 6)];

  const parse = (url: string, html: string): CrawledPage => ({
    url,
    title: (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim().slice(0, 200),
    meta: (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)?.[1] ?? '').trim().slice(0, 300),
    h1: (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? '').replace(/<[^>]+>/g, '').trim().slice(0, 200),
    word_count: (html.replace(/<[^>]+>/g, ' ').match(/\S+/g) ?? []).length,
  });

  const pages: CrawledPage[] = [parse(base, home.html)];
  for (const url of targets.slice(1)) {
    const pg = await fetchPage(url);
    if (pg) pages.push(parse(url, pg.html));
  }
  const navMatches = [...home.html.matchAll(/<nav[\s\S]*?<\/nav>/gi)].map((x) => x[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300));
  return { pages, nav: navMatches.slice(0, 2) };
}

async function crawlSiteReport(ctx: StepContext): Promise<Record<string, unknown>> {
  const p = profileOf(ctx.run);
  const host = (ctx.run.domain as string | undefined) || (p.website_url ? toHost(p.website_url) : '');
  // SOP #3: no reachable site -> skip (no API call).
  if (!host || !host.includes('.')) {
    return { skipped: true, reason: 'no website to crawl' };
  }
  const crawl = await crawlSite(ctx, host);
  if (crawl.pages.length === 0) {
    return { skipped: true, reason: `site ${host} not reachable` };
  }
  const system = loadPromptSystem('04-crawl-site-report.md');
  const user =
    `CRAWL_DATA: ${JSON.stringify({ pages: crawl.pages, site: { nav: crawl.nav } })}\n` +
    `CLIENT_PROFILE: ${JSON.stringify(pick(p, ['focus_services', 'geo_targets', 'ideal_patient', 'differentiators', 'credentials', 'website_url']))}`;
  const text = await draft({ systemText: system, userText: user });
  return { pages_crawled: crawl.pages.length, host, draft: text };
}

// --- Prompt 5: SEO roadmap (synthesis) ---------------------------------------
async function seoRoadmap(ctx: StepContext): Promise<Record<string, unknown>> {
  const p = profileOf(ctx.run);
  const crawl = await siblingOutput(ctx.run.id, 'crawl.site_report');
  const dfs = await siblingOutput(ctx.run.id, 'dataforseo.pull');
  const siteAnalysis = (crawl?.output?.draft as string) ?? 'not available (crawl was skipped or unavailable)';
  const dataforseo = dfs?.output ? JSON.stringify(dfs.output) : 'not available';
  const system = loadPromptSystem('05-seo-roadmap.md');
  const user =
    `SITE_ANALYSIS: ${siteAnalysis}\n` +
    `DATAFORSEO: ${dataforseo}\n` +
    `CLIENT_PROFILE: ${JSON.stringify(pick(p, ['focus_services', 'geo_targets', 'ideal_patient', 'goals_12mo']))}`;
  const text = await draft({ systemText: system, userText: user });
  return { draft: text, used_crawl: crawl?.status === 'succeeded', used_dataforseo: !!dfs?.output };
}

// --- Prompt 6: press topics + content calendar (shared prompt, deliverable switch)
async function research(ctx: StepContext, deliverable: 'press' | 'calendar'): Promise<Record<string, unknown>> {
  const p = profileOf(ctx.run);
  const system = loadPromptSystem('06-press-and-calendar.md');
  const user =
    `DELIVERABLE: ${deliverable}\n` +
    `CLIENT_PROFILE: ${JSON.stringify(pick(p, ['focus_services', 'ideal_patient', 'differentiators', 'credentials', 'goals_12mo', 'geo_targets', 'usp_reason']))}`;
  const text = await draft({ systemText: system, userText: user });
  return { deliverable, draft: text };
}

// --- wave2.rollup: deliver the drafts to Slack -------------------------------
// The AI steps that produce a human-readable draft (output_json.draft). These
// are posted in full as threaded replies under the rollup summary message.
const DRAFT_STEPS: { key: string; title: string }[] = [
  { key: 'gbp.optimize_plan',        title: 'Google Business Profile optimization plan' },
  { key: 'crawl.site_report',        title: 'Website / SEO audit' },
  { key: 'seo.roadmap',              title: 'SEO roadmap' },
  { key: 'research.press_topics',    title: 'Press / PR topics' },
  { key: 'research.content_calendar', title: 'Content calendar' },
];

const STATUS_STEPS = [
  'dataforseo.pull',
  'advicelocal.listings',
  'ghl.a2p_registration',
];

/** Split a long body into Slack-safe chunks (mrkdwn ~3500 chars/message). */
function chunk(text: string, size = 3500): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > size) {
    // Prefer to break on a paragraph/line boundary near the limit.
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size * 0.5) cut = size;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.trim()) out.push(rest);
  return out;
}

async function postSlack(
  ctx: StepContext,
  channel: string,
  text: string,
  thread_ts?: string,
): Promise<string | undefined> {
  const res = await callApi<any>(ctx, `${SLACK}/chat.postMessage`, 'slack.chat.postMessage', {
    method: 'POST',
    headers: { authorization: `Bearer ${config.slack.botToken()}` },
    json: { channel, text, mrkdwn: true, ...(thread_ts ? { thread_ts } : {}) },
  });
  if (!res.body?.ok) throw new Error(`slack.chat.postMessage: ${res.body?.error ?? 'unknown'}`);
  return res.body.ts as string | undefined;
}

async function wave2Rollup(ctx: StepContext): Promise<Record<string, unknown>> {
  const allKeys = [...DRAFT_STEPS.map((d) => d.key), ...STATUS_STEPS];
  const { data: steps } = await db()
    .from('run_steps')
    .select('step_key, status, output_json')
    .eq('run_id', ctx.run.id)
    .in('step_key', allKeys);
  const byKey = new Map((steps ?? []).map((s) => [s.step_key as string, s]));

  const lines = allKeys.map((k) => {
    const s = byKey.get(k);
    return `• ${statusEmoji((s?.status as string) ?? 'pending')} ${k}: ${s?.status ?? 'pending'}`;
  });
  const summary =
    `*Wave 2 research ready for review — ${ctx.run.client_name ?? 'client'}*\n` +
    `All AI outputs below are DRAFTS and need approval before use. ` +
    `The full drafts are in this thread 🧵\n\n` +
    lines.join('\n');

  const channel = ctx.run.slack_channel_id as string | undefined;
  if (!channel) return { posted: false, reason: 'no slack channel on run', summary };

  // 1) Post the summary; everything else threads under it to keep the channel tidy.
  const rootTs = await postSlack(ctx, channel, summary);

  // 2) Post each available draft as threaded reply(ies).
  let postedDrafts = 0;
  for (const d of DRAFT_STEPS) {
    const s = byKey.get(d.key);
    const out = (s?.output_json ?? {}) as Record<string, unknown>;
    const body = typeof out.draft === 'string' ? out.draft.trim() : '';
    if (!body) {
      if (s && (s.status === 'skipped' || s.status === 'flagged' || s.status === 'failed')) {
        const reason = typeof out.reason === 'string' ? ` — ${out.reason}` : '';
        await postSlack(ctx, channel, `*${d.title}* — _${s.status}${reason}_`, rootTs);
      }
      continue;
    }
    const parts = chunk(body);
    for (let i = 0; i < parts.length; i++) {
      const header = parts.length > 1 ? `*${d.title}* _(part ${i + 1}/${parts.length})_\n` : `*${d.title}*\n`;
      await postSlack(ctx, channel, `${header}${parts[i]}`, rootTs);
    }
    postedDrafts++;
  }

  return { posted: true, ts: rootTs, drafts_delivered: postedDrafts };
}

async function wave2RollupDry(ctx: StepContext): Promise<Record<string, unknown>> {
  return simulated({ posted: false, note: 'would post the Wave 2 summary + full drafts to the client Slack channel' });
}

function statusEmoji(s: string): string {
  return s === 'succeeded' ? '✅' : s === 'simulated' ? '🔵' : s === 'skipped' ? '⏭️' : s === 'flagged' || s === 'failed' ? '⚠️' : '⏳';
}

// read-safe AI steps: same fn for runReal/runDry (run for real in both modes).
function aiStep(key: string, dependsOn: string[], fn: (ctx: StepContext) => Promise<Record<string, unknown>>, applicable?: (run: any) => boolean): Step {
  return {
    key, wave: 2, safetyClass: 'read-safe', dependsOn, maxAttempts: 2, retryProfile: 'ai',
    isApplicable: applicable ?? (() => true),
    runReal: fn,
    runDry: fn,
  };
}

// Wave 2 AI steps are gated on profile.normalize_clientform: they only run once
// the Client MMW onboarding form has arrived, so each Opus draft is generated a
// single time, on the rich form data, rather than twice on thin intake data.
const G = ['phase0.gate', 'profile.normalize_clientform'];

export const wave2Steps: Step[] = [
  aiStep('gbp.optimize_plan', G, gbpOptimizePlan),
  aiStep('crawl.site_report', G, crawlSiteReport),
  aiStep('seo.roadmap', ['crawl.site_report', 'dataforseo.pull'], seoRoadmap),
  aiStep('research.press_topics', G, (ctx) => research(ctx, 'press')),
  aiStep('research.content_calendar', G, (ctx) => research(ctx, 'calendar')),
  {
    key: 'wave2.rollup', wave: 2, safetyClass: 'reversible-write',
    dependsOn: ['gbp.optimize_plan', 'crawl.site_report', 'seo.roadmap', 'research.press_topics', 'research.content_calendar', 'dataforseo.pull', 'advicelocal.listings', 'ghl.a2p_registration'],
    maxAttempts: 3, isApplicable: () => true, runReal: wave2Rollup, runDry: wave2RollupDry,
  },
];
