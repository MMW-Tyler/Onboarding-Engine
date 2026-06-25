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
  {
    // iMatrix / Internet Brands proprietary "WM2" builder (ChiroMatrix,
    // OptometryMatrix, etc.). Distinctive markers: their deferred-script type,
    // the wm-* custom elements + wmJsConfig bootstrap, the evona.app media CDN,
    // and the chiromatrixbase.com / imatrix.com back-end. Proprietary, so it is
    // a refer-out / rebuild for MMW (never a take-in-house "green light").
    platform: 'iMatrix',
    html: [
      /dba iMatrix/i,
      /\bimatrix\.com\b/i,
      /chiromatrixbase\.com/i,
      /chiromatrix/i,
      /(?:media|storage)\.evona\.app/i,
      /text\/wmdjs/i,
      /wmJsConfig|globalThis\.WMComponents|<wm-img/i,
    ],
    host: [/chiromatrixbase\.com/i],
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

/**
 * WordPress page-builder / theme-framework fingerprints. Only run when the
 * underlying platform is WordPress. Elementor is MMW's "green light" - flagged
 * separately so the team can immediately tell take-it-in-house from refer-out.
 */
interface BuilderSignature {
  builder: string;
  html: RegExp[];
}
const WP_BUILDERS: BuilderSignature[] = [
  {
    builder: 'Elementor',
    html: [
      /elementor-frontend/i,
      /\/wp-content\/plugins\/elementor\//i,
      /data-elementor-/i,
      /<meta[^>]+generator[^>]+Elementor/i,
      /\belementor-pro\b/i,
    ],
  },
  {
    builder: 'Divi',
    html: [/\/themes\/Divi\//i, /et_pb_/i, /et-builder/i, /<body[^>]+et_pb_pagebuilder/i],
  },
  {
    builder: 'Beaver Builder',
    html: [/fl-builder/i, /\/wp-content\/plugins\/bb-plugin\//i, /\/themes\/bb-theme\//i],
  },
  {
    builder: 'WPBakery',
    html: [/js_composer/i, /\bvc_row\b/i, /\bwpb_animate/i],
  },
  {
    builder: 'Oxygen',
    html: [/ct-section|ct-div-block|oxy-/i, /\/wp-content\/plugins\/oxygen\//i],
  },
  {
    builder: 'Bricks',
    html: [/brxe-|brx-container|bricks-builder/i, /\/themes\/bricks\//i],
  },
  {
    builder: 'Breakdance',
    html: [/breakdance-|\/wp-content\/plugins\/breakdance\//i],
  },
  {
    builder: 'Gutenberg / Block Theme',
    html: [/wp-block-/i, /\/themes\/twenty(?:twenty|twentyone|twentytwo|twentythree|twentyfour|twentyfive)/i],
  },
  {
    builder: 'Astra',
    html: [/\/themes\/astra\//i, /astra-/i],
  },
  {
    builder: 'GeneratePress',
    html: [/\/themes\/generatepress\//i, /\bgeneratepress\b/i],
  },
  {
    builder: 'Kadence',
    html: [/\/themes\/kadence\//i, /\bkadence-/i],
  },
  {
    builder: 'OceanWP',
    html: [/\/themes\/oceanwp\//i, /\boceanwp-/i],
  },
];

/** Find the WP theme slug from the homepage HTML, when one is exposed. */
function detectWpTheme(html: string): string | null {
  const m = html.match(/\/wp-content\/themes\/([a-zA-Z0-9_\-]+)\//);
  return m?.[1] ?? null;
}

/** Match every WP builder whose signature appears; returns names ordered by hit count. */
function detectWpBuilders(html: string): { builder: string; hits: number }[] {
  return WP_BUILDERS.map((b) => {
    const hits = b.html.reduce((n, re) => (re.test(html) ? n + 1 : n), 0);
    return { builder: b.builder, hits };
  }).filter((b) => b.hits > 0).sort((a, b) => b.hits - a.hits);
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

  // For WordPress, identify the page builder / theme framework. Elementor is
  // MMW's "green light" - flagged separately so the team knows immediately
  // whether they can take the build in-house.
  let wpBuilders: { builder: string; hits: number }[] = [];
  let wpTheme: string | null = null;
  let mmwReady: boolean | null = null;
  if (platform === 'WordPress') {
    wpBuilders = detectWpBuilders(html);
    wpTheme = detectWpTheme(html);
    const builderName = wpBuilders[0]?.builder ?? null;
    mmwReady = builderName === 'Elementor';
    if (!mmwReady) {
      await ctx.logEvent({
        level: 'warn',
        endpoint: 'crawl.detect_platform',
        parsed_error: `WordPress site is ${builderName ?? 'unknown builder'} (not Elementor) - review before taking in-house`,
      });
    }
  }

  // Record the detection on the run profile (non-sensitive).
  const existing = (ctx.run.client_profile_json ?? {}) as Record<string, unknown>;
  const update: Record<string, unknown> = { detected_platform: platform };
  if (platform === 'WordPress') {
    if (wpBuilders[0]) update.detected_wp_builder = wpBuilders[0].builder;
    if (wpTheme) update.detected_wp_theme = wpTheme;
    if (mmwReady !== null) update.mmw_take_in_house = mmwReady;
  }
  await db().from('onboarding_runs')
    .update({ client_profile_json: { ...existing, ...update }, updated_at: new Date().toISOString() })
    .eq('id', ctx.run.id);

  return {
    platform,
    confidence,
    reachable: true,
    final_url: finalUrl,
    wp_builder: wpBuilders[0]?.builder ?? null,
    wp_theme: wpTheme,
    mmw_take_in_house: mmwReady,
    other_builder_candidates: wpBuilders.slice(1, 4),
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
