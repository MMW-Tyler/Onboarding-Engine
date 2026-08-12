import type { Step, StepContext } from '../../types.js';
import { db } from '../../supabase.js';
import { profileOf, siblingOutput } from './util.js';
import { toHost, looksLikeDomain } from '../../lib/domain.js';
import { fetchSite } from '../../lib/site.js';

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

/**
 * The host to fingerprint: the client's EXISTING site.
 *
 * Must prefer profile.website_url over ctx.run.domain. Both this step and
 * namecheap.purchase_domain hang off profile.normalize_intake, so they are
 * enqueued together and their order is not guaranteed - and the purchase step
 * OVERWRITES run.domain with the domain it just bought (<base>px.com), which by
 * definition has no website on it yet. Reading run.domain first meant that
 * whenever the purchase won the race, this step fetched a freshly-registered
 * domain, got nothing, and reported "unknown". crawl.site_report already gets
 * this right (see wave2.ts); this is the same rule.
 */
async function siteHost(ctx: StepContext): Promise<string | null> {
  const websiteUrl = profileOf(ctx.run).website_url;
  const fromProfile = websiteUrl && looksLikeDomain(websiteUrl) ? toHost(websiteUrl) : '';
  if (fromProfile) return fromProfile;

  const host = (ctx.run.domain as string | undefined)?.trim() ?? '';
  if (!host || !host.includes('.')) return null;
  // No website on the profile and run.domain is the domain we just bought: that
  // is a brand-new registration with nothing served on it, so there is nothing
  // to fingerprint. Say so instead of reporting the client's site as unreachable.
  const purchase = await siblingOutput(ctx.run.id, 'namecheap.purchase_domain');
  if (toHost(String(purchase?.output?.domain ?? '')) === toHost(host)) return null;
  return host;
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

// --- Richer tech fingerprint (theme(s), plugins, integrations, fonts) --------
// All pulled from the same homepage HTML: WP assets expose plugin/theme slugs in
// their URLs, fonts come from the Google Fonts <link>, and third-party widgets
// (chat, donations, analytics) load from their own domains.

/** Friendly display names for common WP plugin slugs. Unmapped slugs pass through. */
const PLUGIN_NAMES: Record<string, string> = {
  'wordpress-seo': 'Yoast SEO',
  'seo-by-rank-math': 'Rank Math SEO',
  'all-in-one-seo-pack': 'All in One SEO',
  'contact-form-7': 'Contact Form 7',
  'wpforms-lite': 'WPForms',
  'wpforms': 'WPForms',
  'gravityforms': 'Gravity Forms',
  'ninja-forms': 'Ninja Forms',
  'formidable': 'Formidable Forms',
  'js_composer': 'WPBakery Page Builder',
  'revslider': 'Slider Revolution',
  'layerslider': 'LayerSlider',
  'megamenu': 'Max Mega Menu',
  'elementor': 'Elementor',
  'elementor-pro': 'Elementor Pro',
  'google-analytics-for-wordpress': 'MonsterInsights',
  'ga-google-analytics': 'Google Analytics',
  'instagram-feed': 'Smash Balloon Instagram Feed',
  'custom-facebook-feed': 'Smash Balloon Facebook Feed',
  'constant-contact-forms': 'Constant Contact Forms',
  'mailchimp-for-wp': 'Mailchimp for WordPress',
  'woocommerce': 'WooCommerce',
  'give': 'GiveWP',
  'wordfence': 'Wordfence Security',
  'sucuri-scanner': 'Sucuri Security',
  'really-simple-ssl': 'Really Simple SSL',
  'wp-rocket': 'WP Rocket',
  'litespeed-cache': 'LiteSpeed Cache',
  'wp-super-cache': 'WP Super Cache',
  'w3-total-cache': 'W3 Total Cache',
  'autoptimize': 'Autoptimize',
  'updraftplus': 'UpdraftPlus',
  'wp-smushit': 'Smush',
  'shortpixel-image-optimiser': 'ShortPixel',
  'cookie-law-info': 'CookieYes',
  'jetpack': 'Jetpack',
  'wp-google-maps': 'WP Google Maps',
  'redirection': 'Redirection',
  'wordpress-popular-posts': 'Popular Posts',
  'tablepress': 'TablePress',
};

/** Third-party / cross-platform tech detectable in HTML (not via plugin paths). */
interface TechSignature { name: string; html: RegExp[] }
const TECH_SIGNATURES: TechSignature[] = [
  { name: 'Google Analytics (GA4)', html: [/gtag\/js\?id=G-/i, /\bG-[A-Z0-9]{6,}\b/] },
  { name: 'Google Analytics (Universal)', html: [/google-analytics\.com\/(?:analytics|ga)\.js/i, /\bUA-\d{4,}-\d+\b/] },
  { name: 'Google Tag Manager', html: [/googletagmanager\.com\/gtm\.js/i, /\bGTM-[A-Z0-9]{4,}\b/] },
  { name: 'Meta Pixel', html: [/connect\.facebook\.net\/[^"']*fbevents\.js/i, /fbq\(\s*['"]init/i] },
  { name: 'MonsterInsights', html: [/monsterinsights/i] },
  { name: 'Yoast SEO', html: [/Yoast SEO plugin/i, /yoast[_-]?wpseo|class="yoast/i] },
  { name: 'Rank Math', html: [/rank[\s-]?math/i] },
  { name: 'Contact Form 7', html: [/wpcf7|contact-form-7/i] },
  { name: 'Gravity Forms', html: [/gravityforms|\bgform_/i] },
  { name: 'Constant Contact', html: [/ctctcdn\.com|constantcontact|constant-contact/i] },
  { name: 'HubSpot Forms', html: [/js\.hsforms\.net|hsforms\.com/i] },
  { name: 'Mailchimp', html: [/chimpstatic\.com|list-manage\.com|mc4wp/i] },
  { name: 'Slider Revolution', html: [/revslider|rev_slider|revolution\/(?:js|css)/i] },
  { name: 'Max Mega Menu', html: [/max-mega-menu|\bmegamenu\b/i] },
  { name: 'Smash Balloon', html: [/sb_instagram|smash-balloon|cff-|custom-facebook-feed|instagram-feed/i] },
  { name: 'FundraiseUp', html: [/fundraiseup/i] },
  { name: 'Donorbox', html: [/donorbox\.org/i] },
  { name: 'GiveWP', html: [/give-wp|givewp|\/plugins\/give\//i] },
  { name: 'Classy', html: [/classy\.org\/embedded/i] },
  { name: 'BotPenguin', html: [/botpenguin/i] },
  { name: 'Intercom', html: [/widget\.intercom\.io|intercomcdn\.com/i] },
  { name: 'Drift', html: [/js\.driftt\.com|drift\.com\/include/i] },
  { name: 'tawk.to', html: [/embed\.tawk\.to/i] },
  { name: 'LiveChat', html: [/cdn\.livechatinc\.com/i] },
  { name: 'Tidio', html: [/code\.tidio\.co/i] },
  { name: 'HubSpot Chat', html: [/js\.hs-scripts\.com/i] },
  { name: 'Calendly', html: [/assets\.calendly\.com/i] },
  { name: 'WooCommerce', html: [/woocommerce|wc-block/i] },
  { name: 'Font Awesome', html: [/font-?awesome|fontawesome/i] },
  { name: 'Bootstrap', html: [/bootstrap(?:\.min)?\.css|\/npm\/bootstrap/i] },
  { name: 'jQuery', html: [/jquery(?:[.-][\d.]+)?(?:\.min)?\.js/i] },
  { name: 'Structured data (Schema.org)', html: [/application\/ld\+json/i] },
];

/** Every WP plugin slug exposed in asset URLs, mapped to friendly names. */
function extractWpPlugins(html: string): string[] {
  const slugs = new Set<string>();
  const re = /\/wp-content\/plugins\/([a-z0-9][a-z0-9_\-]*)\//gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) slugs.add(m[1]!.toLowerCase());
  return [...slugs].sort().map((s) => PLUGIN_NAMES[s] ?? s);
}

/** Every WP theme slug exposed in asset URLs (catches parent + child themes). */
function extractWpThemes(html: string): string[] {
  const slugs = new Set<string>();
  const re = /\/wp-content\/themes\/([a-z0-9][a-z0-9_\-]*)\//gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) slugs.add(m[1]!.toLowerCase());
  return [...slugs];
}

/** Google Font families referenced via the Google Fonts CSS link(s). */
function extractGoogleFonts(html: string): string[] {
  const fams = new Set<string>();
  const links = html.match(/fonts\.googleapis\.com\/css2?\?[^"')\s]+/gi) ?? [];
  for (const link of links) {
    for (const fm of link.match(/family=([^&]+)/gi) ?? []) {
      const raw = decodeURIComponent(fm.replace(/^family=/i, '')).replace(/\+/g, ' ');
      for (const part of raw.split('|')) {
        const name = part.split(':')[0]!.trim();
        if (name) fams.add(name);
      }
    }
  }
  return [...fams];
}

/** Third-party integrations matched from TECH_SIGNATURES. */
function detectIntegrations(html: string): string[] {
  return TECH_SIGNATURES.filter((s) => s.html.some((re) => re.test(html))).map((s) => s.name);
}

interface TechProfile {
  themes: string[];
  plugins: string[];
  integrations: string[];
  fonts: string[];
}

/** Full tech fingerprint from one homepage HTML. */
function buildTechProfile(html: string): TechProfile {
  return {
    themes: extractWpThemes(html),
    plugins: extractWpPlugins(html),
    integrations: detectIntegrations(html),
    fonts: extractGoogleFonts(html),
  };
}

/** Match every WP builder whose signature appears; returns names ordered by hit count. */
function detectWpBuilders(html: string): { builder: string; hits: number }[] {
  return WP_BUILDERS.map((b) => {
    const hits = b.html.reduce((n, re) => (re.test(html) ? n + 1 : n), 0);
    return { builder: b.builder, hits };
  }).filter((b) => b.hits > 0).sort((a, b) => b.hits - a.hits);
}

async function detectPlatform(ctx: StepContext): Promise<Record<string, unknown>> {
  const host = await siteHost(ctx);
  if (!host) {
    await ctx.logEvent({
      level: 'warn',
      endpoint: 'crawl.detect_platform',
      parsed_error: 'no existing client website on the run - nothing to fingerprint',
    });
    return { platform: 'unknown', reachable: false, reason: 'no_website' };
  }

  const started = Date.now();
  const site = await fetchSite(host, { timeoutMs: 15_000, maxBytes: 300_000 });
  const tried = site.attempts.map((a) => `${a.url} -> ${a.status ?? a.error}`).join(', ');
  if (!site.ok) {
    await ctx.logEvent({
      level: 'warn',
      endpoint: `GET ${site.url}`,
      response_status: site.status ?? undefined,
      parsed_error: `could not read ${host} (${site.reason}); tried: ${tried}`,
      duration_ms: Date.now() - started,
    });
    return { platform: 'unknown', reachable: false, url: site.url, reason: site.reason, attempts: site.attempts };
  }
  await ctx.logEvent({
    level: 'info',
    endpoint: `GET ${site.url}`,
    response_status: site.status ?? undefined,
    response_body: { tried },
    duration_ms: Date.now() - started,
  });
  const html = site.html;
  const finalUrl = site.url;
  const headers = site.headers;

  // Score each platform by how many of its signatures match.
  const scores = SIGNATURES.map((sig) => {
    const evidence: string[] = [];
    for (const re of sig.html ?? []) if (re.test(html)) evidence.push(`html:${re.source.slice(0, 40)}`);
    for (const h of sig.headers ?? []) if (h.pattern.test(headers[h.name] ?? '')) evidence.push(`header:${h.name}`);
    for (const re of sig.host ?? []) if (re.test(finalUrl)) evidence.push(`host:${re.source.slice(0, 30)}`);
    return { platform: sig.platform, hits: evidence.length, evidence };
  }).filter((s) => s.hits > 0).sort((a, b) => b.hits - a.hits);

  // Last resort before giving up: most builders announce themselves in the
  // generator meta tag even when none of the signatures above fit, so a site on
  // something we've never seen still comes back named instead of "unknown".
  const generator = html.match(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']/i)?.[1]?.trim() ?? null;

  const best = scores[0];
  const platform = best?.platform ?? (generator ? `${generator} (from generator tag)` : 'unknown');
  const confidence = best ? (best.hits >= 2 ? 'high' : 'low') : generator ? 'low' : 'none';
  if (!best) {
    await ctx.logEvent({
      level: 'warn',
      endpoint: 'crawl.detect_platform',
      parsed_error:
        `read ${finalUrl} (${html.length} bytes) but no platform signature matched` +
        (generator ? ` - generator tag says "${generator}"` : ' and there is no generator tag') +
        '. Custom build, or a fingerprint we do not have yet.',
    });
  }

  // Cross-check against what the intake form claimed. Both sides are free text
  // (the generator tag especially - "Site.pro (v2)" would be an invalid regex),
  // so escape before building the comparison patterns.
  const claimed = profileOf(ctx.run).website_build_type ?? '';
  const firstWord = (s: string) => (s.split(' ')[0] ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matchesIntake = claimed
    ? new RegExp(firstWord(platform) || '$^', 'i').test(claimed) || new RegExp(firstWord(claimed) || '$^', 'i').test(platform)
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

  // Richer tech fingerprint from the same HTML: theme(s), plugins, third-party
  // integrations (analytics / chat / donations / forms), and Google Fonts. Runs
  // for any reachable site (plugins/themes stay empty for non-WordPress).
  const tech = buildTechProfile(html);
  // Prefer the full theme list for WordPress; fall back to the single-slug match.
  const themes = tech.themes.length ? tech.themes : (wpTheme ? [wpTheme] : []);

  // Record the detection on the run profile (non-sensitive).
  const existing = (ctx.run.client_profile_json ?? {}) as Record<string, unknown>;
  const update: Record<string, unknown> = { detected_platform: platform };
  if (platform === 'WordPress') {
    if (wpBuilders[0]) update.detected_wp_builder = wpBuilders[0].builder;
    if (wpTheme) update.detected_wp_theme = wpTheme;
    if (mmwReady !== null) update.mmw_take_in_house = mmwReady;
  }
  if (themes.length) update.detected_themes = themes;
  if (tech.plugins.length) update.detected_plugins = tech.plugins;
  if (tech.integrations.length) update.detected_integrations = tech.integrations;
  if (tech.fonts.length) update.detected_fonts = tech.fonts;
  await db().from('onboarding_runs')
    .update({ client_profile_json: { ...existing, ...update }, updated_at: new Date().toISOString() })
    .eq('id', ctx.run.id);

  return {
    platform,
    confidence,
    reachable: true,
    final_url: finalUrl,
    generator,
    fetch_attempts: site.attempts,
    wp_builder: wpBuilders[0]?.builder ?? null,
    wp_theme: wpTheme,
    mmw_take_in_house: mmwReady,
    other_builder_candidates: wpBuilders.slice(1, 4),
    claimed_intake_type: claimed || null,
    matches_intake: matchesIntake,
    candidates: scores.slice(0, 3),
    themes,
    plugins: tech.plugins,
    integrations: tech.integrations,
    fonts: tech.fonts,
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
