import type { Step, StepContext } from '../../types.js';
import { db } from '../../supabase.js';
import { profileOf } from './util.js';
import { toHost } from '../../lib/domain.js';

/**
 * crawl.detect_platform (read-safe): fetch the client's homepage and fingerprint
 * which website platform it runs on (WordPress, Squarespace, Wix, Shopify, etc.),
 * so a human doesn't have to eyeball it. Cross-checks the detected platform
 * against the intake form's "Website Build Type" and notes any mismatch.
 *
 * Pure read (one GET), so it runs for real in dry and live. Never fails the run
 * over an unreachable/ambiguous site - it just reports "unknown".
 */

interface Signature {
  platform: string;
  // any match counts; more matches => higher confidence
  html?: RegExp[];
  headers?: { name: string; pattern: RegExp }[];
  host?: RegExp[]; // matched against the final (post-redirect) URL
}

const SIGNATURES: Signature[] = [
  {
    platform: 'WordPress',
    html: [/\/wp-content\//i, /\/wp-includes\//i, /<meta[^>]+generator[^>]+WordPress/i, /wp-json/i],
    headers: [{ name: 'link', pattern: /wp-json/i }],
  },
  {
    platform: 'Squarespace',
    html: [/squarespace-cdn\.com/i, /static1\.squarespace\.com/i, /<meta[^>]+generator[^>]+Squarespace/i, /Squarespace\.afterBodyLoad/i],
    headers: [{ name: 'server', pattern: /Squarespace/i }],
    host: [/squarespace\.com/i],
  },
  {
    platform: 'Wix',
    html: [/static\.wixstatic\.com/i, /_wix/i, /wix\.com/i],
    headers: [{ name: 'x-wix-request-id', pattern: /.+/i }, { name: 'server', pattern: /Pepyaka|wix/i }],
    host: [/wixsite\.com|editorx\.io/i],
  },
  {
    platform: 'Shopify',
    html: [/cdn\.shopify\.com/i, /Shopify\.theme/i, /myshopify\.com/i],
    headers: [{ name: 'x-shopid', pattern: /.+/i }, { name: 'x-shopify-stage', pattern: /.+/i }, { name: 'powered-by', pattern: /Shopify/i }],
    host: [/myshopify\.com/i],
  },
  {
    platform: 'Webflow',
    html: [/<meta[^>]+generator[^>]+Webflow/i, /assets\.website-files\.com/i, /assets-global\.website-files\.com/i, /\.w-/i],
    host: [/webflow\.io/i],
  },
  {
    platform: 'GoDaddy Website Builder',
    html: [/img1\.wsimg\.com/i, /websitebuilder/i],
    headers: [{ name: 'server', pattern: /DPS\//i }],
  },
  {
    platform: 'Duda',
    html: [/irp\.cdn-website\.com|lirp\.cdn-website\.com/i, /dudaone|_dm_/i, /<meta[^>]+generator[^>]+Duda/i],
  },
  {
    platform: 'Weebly',
    html: [/weebly\.com|editmysite\.com/i, /<meta[^>]+generator[^>]+Weebly/i],
  },
  {
    platform: 'HubSpot CMS',
    html: [/hs-sites\.com|hsforms|hscollectedforms/i, /<meta[^>]+generator[^>]+HubSpot/i],
    headers: [{ name: 'x-hs-cache-config', pattern: /.+/i }],
  },
  {
    platform: 'Drupal',
    html: [/<meta[^>]+generator[^>]+Drupal/i, /sites\/all|sites\/default\/files/i],
    headers: [{ name: 'x-generator', pattern: /Drupal/i }],
  },
  {
    platform: 'Joomla',
    html: [/<meta[^>]+generator[^>]+Joomla/i, /\/media\/jui\//i],
  },
  {
    platform: 'Framer',
    html: [/<meta[^>]+generator[^>]+Framer/i, /framerusercontent\.com/i],
    host: [/framer\.(website|app)/i],
  },
];

function siteUrl(ctx: StepContext): string | null {
  const host = (ctx.run.domain as string | undefined)?.trim() || (() => {
    const w = profileOf(ctx.run).website_url;
    return w ? toHost(w) : '';
  })();
  if (!host || !host.includes('.')) return null;
  return `https://${host}`;
}

async function detectPlatform(ctx: StepContext): Promise<Record<string, unknown>> {
  const url = siteUrl(ctx);
  if (!url) {
    await ctx.logEvent({ level: 'warn', endpoint: 'crawl.detect_platform', parsed_error: 'no usable website on the run' });
    return { platform: 'unknown', reachable: false, reason: 'no_website' };
  }

  let html = '';
  let finalUrl = url;
  const headers: Record<string, string> = {};
  const started = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; OnboardEngine/1.0; +platform-detect)' },
    }).finally(() => clearTimeout(timer));
    finalUrl = res.url || url;
    res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    html = (await res.text()).slice(0, 300_000); // cap body
    await ctx.logEvent({ level: 'info', endpoint: `GET ${url}`, response_status: res.status, duration_ms: Date.now() - started });
  } catch (err) {
    await ctx.logEvent({ level: 'warn', endpoint: `GET ${url}`, parsed_error: `unreachable: ${err instanceof Error ? err.message : String(err)}`, duration_ms: Date.now() - started });
    return { platform: 'unknown', reachable: false, url, reason: 'unreachable' };
  }

  // Score each platform by how many of its signatures match.
  const scores = SIGNATURES.map((sig) => {
    const evidence: string[] = [];
    for (const re of sig.html ?? []) if (re.test(html)) evidence.push(`html:${re.source.slice(0, 40)}`);
    for (const h of sig.headers ?? []) if (h.pattern.test(headers[h.name] ?? '')) evidence.push(`header:${h.name}`);
    for (const re of sig.host ?? []) if (re.test(finalUrl)) evidence.push(`host:${re.source.slice(0, 30)}`);
    return { platform: sig.platform, hits: evidence.length, evidence };
  }).filter((s) => s.hits > 0).sort((a, b) => b.hits - a.hits);

  const best = scores[0];
  const platform = best?.platform ?? 'unknown';
  const confidence = !best ? 'none' : best.hits >= 2 ? 'high' : 'low';

  // Cross-check against what the intake form claimed.
  const claimed = profileOf(ctx.run).website_build_type ?? '';
  const matchesIntake = claimed
    ? new RegExp(platform.split(' ')[0]!, 'i').test(claimed) || new RegExp(claimed.split(' ')[0]!, 'i').test(platform)
    : null;
  if (claimed && matchesIntake === false && platform !== 'unknown') {
    await ctx.logEvent({ level: 'warn', endpoint: 'crawl.detect_platform', parsed_error: `intake said "${claimed}" but site looks like ${platform}` });
  }

  // Record the detection on the run profile (non-sensitive).
  const existing = (ctx.run.client_profile_json ?? {}) as Record<string, unknown>;
  await db().from('onboarding_runs')
    .update({ client_profile_json: { ...existing, detected_platform: platform }, updated_at: new Date().toISOString() })
    .eq('id', ctx.run.id);

  return {
    platform,
    confidence,
    reachable: true,
    final_url: finalUrl,
    claimed_intake_type: claimed || null,
    matches_intake: matchesIntake,
    candidates: scores.slice(0, 3),
  };
}

export const crawlSteps: Step[] = [
  {
    key: 'crawl.detect_platform',
    wave: 1,
    safetyClass: 'read-safe',
    dependsOn: ['profile.normalize_intake'],
    maxAttempts: 2,
    retryProfile: 'standard',
    isApplicable: () => true,
    runReal: detectPlatform,
    runDry: detectPlatform, // read-safe: same in both modes
  },
];
