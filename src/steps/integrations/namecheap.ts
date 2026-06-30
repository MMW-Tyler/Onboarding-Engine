import type { Step, StepContext } from '../../types.js';
import { db } from '../../supabase.js';
import { callApi } from '../../lib/http.js';
import { config } from '../../config.js';
import { namecheapUrl, unwrapRelayXml } from '../../lib/namecheap.js';
import { profileOf, simulated } from './util.js';

/**
 * Namecheap domain-purchase worker (spec section 04: money guardrail; section 08).
 *
 * Safety model:
 *   - runDry: calls only domains.check + users.getPricing (read-safe, free). Never
 *     calls domains.create. Never writes to the database.
 *   - runReal: calls domains.create ONLY because the runner has already verified the
 *     two-key unlock (NAMECHEAP_LIVE env + per-run unlock token) before dispatching
 *     any step whose safetyClass is 'costly'. This function may assume it is
 *     authorized to purchase.
 *
 * All calls use the Namecheap XML API (GET requests). Responses are XML strings;
 * we parse minimally with regex rather than adding an XML library dependency.
 */

// ---------------------------------------------------------------------------
// URL builder
// ---------------------------------------------------------------------------

/**
 * Build the full Namecheap API URL (routes through the static-IP relay when
 * NAMECHEAP_RELAY_URL is configured - see src/lib/namecheap.ts).
 */
function ncUrl(command: string, extra: Record<string, string> = {}): string {
  return namecheapUrl(command, extra);
}

// ---------------------------------------------------------------------------
// Domain resolution
// ---------------------------------------------------------------------------

/**
 * The client's EXISTING website, used as the base for the new domain to buy.
 * Prefers the profile's website_url (set by normalize_intake on the full flow);
 * falls back to ctx.run.domain (what's typed into the Website URL field on a
 * manual domain_warmup_only run). A successful purchase backfills website_url
 * from this so re-runs stay stable even after run.domain is overwritten with the
 * purchased domain (avoids nezhatpx -> nezhatpxpx compounding).
 */
function siteSource(ctx: StepContext): string {
  const fromProfile = profileOf(ctx.run).website_url ?? '';
  if (fromProfile.trim()) return fromProfile.trim();
  const fromRun = (ctx.run.domain as string | undefined) ?? '';
  if (fromRun.trim()) return fromRun.trim();
  // Manual domain_warmup_only runs skip normalize_intake, so the website only
  // lives in the raw intake payload (e.g. the dashboard's "Website URL" field).
  return websiteFromIntake(ctx);
}

/** Pull a website-like value out of the raw intake payload (manual fire / webhook). */
function websiteFromIntake(ctx: StepContext): string {
  const raw = (ctx.run.raw_intake_json ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(raw)) {
    if (/website|url|site|domain/i.test(key) && typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

/** Brandable base label from a website/domain string, e.g. www.nezhat.org -> 'nezhat'. */
function baseLabel(ctx: StepContext): string {
  const source = siteSource(ctx);
  if (source) {
    try {
      const url = new URL(source.startsWith('http') ? source : `https://${source}`);
      const host = url.hostname.replace(/^www\./, '');
      const sld = host.split('.')[0] ?? '';
      const clean = sld.toLowerCase().replace(/[^a-z0-9-]/g, '');
      if (clean) return clean;
    } catch {
      // fall through to slug approach
    }
  }
  const name = (profileOf(ctx.run).office_name ?? ctx.run.client_name ?? 'client').toLowerCase();
  return name.replace(/[^a-z0-9]+/g, '').slice(0, 50) || 'client';
}

/**
 * The ordered list of domains to attempt to purchase for this client:
 *   1. <base>px.com         (preferred - shortest, keeps SMS trigger links short
 *                            so texts stay cheaper and URLs don't break)
 *   2. <base>patients.com   (fallback if px.com is taken)
 * where <base> is the client's existing website name (see baseLabel).
 */
function purchaseCandidates(ctx: StepContext): string[] {
  const base = baseLabel(ctx);
  return [`${base}px.com`, `${base}patients.com`];
}

/** Availability outcome for one domain, distinguishing API errors from "taken". */
type CheckOutcome =
  | { available: true; isPremium: boolean; premiumPrice: number; icannFee: number }
  | { available: false }
  | { error: string };

/** Read a numeric attribute off the DomainCheckResult element. */
function numAttr(el: string, name: string): number {
  const m = el.match(new RegExp(`${name}\\s*=\\s*"([\\d.]+)"`, 'i'));
  return m ? parseFloat(m[1]!) : 0;
}

/**
 * Interpret a domains.check response. A real result has a DomainCheckResult with
 * Available="true|false"; anything else (Status="ERROR", no result element,
 * relay mangling) is surfaced as an error rather than silently read as "taken".
 * On an available result we also capture premium pricing for the price guard.
 */
function checkOutcome(rawXml: string): CheckOutcome {
  const xml = unwrapRelayXml(rawXml);
  if (/Status\s*=\s*"ERROR"/i.test(xml)) {
    return { error: parseApiError(xml) ?? 'Namecheap API error' };
  }
  const el = xml.match(/<DomainCheckResult[^>]*>/i)?.[0];
  const avail = el?.match(/\bAvailable\s*=\s*"(true|false)"/i);
  if (!el || !avail) {
    return { error: `unexpected domains.check response (no DomainCheckResult); first 200 chars: ${xml.slice(0, 200)}` };
  }
  if (avail[1]!.toLowerCase() !== 'true') return { available: false };
  return {
    available: true,
    isPremium: /IsPremiumName\s*=\s*"true"/i.test(el),
    premiumPrice: numAttr(el, 'PremiumRegistrationPrice'),
    icannFee: numAttr(el, 'IcannFee'),
  };
}

/** The standard 1-year .com registration price (YourPrice), via users.getPricing. */
async function comRegisterPrice(ctx: StepContext): Promise<number | null> {
  const res = await callApi(
    ctx,
    ncUrl('namecheap.users.getPricing', { ProductType: 'DOMAIN', ProductCategory: 'REGISTER', ActionName: 'REGISTER', ProductName: 'com' }),
    'namecheap.users.getPricing',
  );
  const xml = unwrapRelayXml(res.raw);
  const seg = xml.match(/<Price\b[^>]*\bDuration="1"[^>]*\/?>/i)?.[0];
  if (!seg) {
    const fallback = parsePrice(xml);
    return fallback ? parseFloat(fallback) : null;
  }
  const yp = seg.match(/YourPrice="([\d.]+)"/i)?.[1] ?? seg.match(/\bPrice="([\d.]+)"/i)?.[1];
  return yp ? parseFloat(yp) : null;
}

/**
 * Estimated total cost (USD) for registering a domain, for the price guard.
 * Premium domains use their premium price; regular domains use the .com price.
 * ICANN fee is added on top. Returns null only if a non-premium price can't be
 * determined (caller decides whether to proceed).
 */
async function estimateCost(ctx: StepContext, outcome: Extract<CheckOutcome, { available: true }>): Promise<number | null> {
  if (outcome.isPremium && outcome.premiumPrice > 0) {
    return outcome.premiumPrice + outcome.icannFee;
  }
  const base = await comRegisterPrice(ctx);
  return base === null ? null : base + outcome.icannFee;
}

// ---------------------------------------------------------------------------
// XML parsing helpers
// ---------------------------------------------------------------------------

/** Extract a first numeric price value from getPricing XML. */
function parsePrice(xml: string): string | null {
  const m = xml.match(/Price\s*=\s*"([^"]+)"/i);
  return m?.[1] ?? null;
}

/** Check whether the API response signals an overall success (Status="OK"). */
function parseApiStatus(xml: string): boolean {
  return /Status\s*=\s*"OK"/i.test(xml);
}

/** Extract the first error description from Errors block, if present. */
function parseApiError(xml: string): string | null {
  const m = xml.match(/<Error[^>]*>([^<]*)<\/Error>/i);
  return m?.[1]?.trim() ?? null;
}

// ---------------------------------------------------------------------------
// runDry: read-safe probe only
// ---------------------------------------------------------------------------

async function purchaseDomainDry(ctx: StepContext): Promise<Record<string, unknown>> {
  const candidates = purchaseCandidates(ctx);

  // domains.check each candidate (free availability check; never charges).
  const checked: { domain: string; available: boolean | null; error?: string }[] = [];
  let firstAvailable: Extract<CheckOutcome, { available: true }> | null = null;
  for (const domain of candidates) {
    const checkRes = await callApi(
      ctx,
      ncUrl('namecheap.domains.check', { DomainList: domain }),
      'namecheap.domains.check',
    );
    const outcome = checkOutcome(checkRes.raw);
    if ('error' in outcome) { checked.push({ domain, available: null, error: outcome.error }); continue; }
    checked.push({ domain, available: outcome.available });
    if (outcome.available && !firstAvailable) firstAvailable = outcome;
  }
  const wouldPurchase = checked.find((c) => c.available === true)?.domain ?? null;

  // Estimate cost + apply the same price cap the real purchase enforces.
  const cap = config.namecheap.maxPrice();
  const cost = firstAvailable ? await estimateCost(ctx, firstAvailable) : null;
  const overCap = cost !== null && cost > cap;

  // NEVER call domains.create in dry mode.
  return simulated({
    candidates: checked,
    would_purchase: overCap ? null : wouldPurchase,
    estimated_cost: cost,
    price_cap: cap,
    over_cap: overCap,
    note: overCap
      ? `dry-run: ${wouldPurchase} ~$${cost!.toFixed(2)} exceeds $${cap} cap - would be flagged`
      : 'dry-run: check + pricing only, no purchase',
  });
}

// ---------------------------------------------------------------------------
// runReal: authorized purchase (runner has verified two-key unlock)
// ---------------------------------------------------------------------------

async function purchaseDomainReal(ctx: StepContext): Promise<Record<string, unknown>> {
  // NOTE: This function is only reached after the runner has verified both
  // NAMECHEAP_LIVE=true and the per-run unlock token. Do not add a secondary
  // guard here - it would silently mask runner failures.

  // Build the candidate list (<base>patients.com, then <base>px.com) and buy the
  // FIRST one that is available. domains.check is a free read; only an available
  // domain is ever purchased, so a taken first choice safely falls back and a
  // domain that's already registered is never bought.
  const candidates = purchaseCandidates(ctx);
  await ctx.logEvent({ level: 'info', endpoint: 'namecheap.purchase.candidates', response_body: { candidates } });

  let domain = '';
  let selected: Extract<CheckOutcome, { available: true }> | null = null;
  for (const candidate of candidates) {
    const checkRes = await callApi(
      ctx,
      ncUrl('namecheap.domains.check', { DomainList: candidate }),
      'namecheap.domains.check',
    );
    const outcome = checkOutcome(checkRes.raw);
    // A genuine API/relay failure must NOT be treated as "taken" - stop and
    // surface it, so we don't fall through to a misleading "nothing available".
    if ('error' in outcome) {
      throw new Error(`namecheap: domains.check failed for ${candidate}: ${outcome.error}`);
    }
    if (outcome.available) {
      domain = candidate;
      selected = outcome;
      break;
    }
  }
  if (!domain || !selected) {
    throw new Error(`namecheap: neither candidate is available to purchase (tried: ${candidates.join(', ')}).`);
  }
  await ctx.logEvent({ level: 'info', endpoint: 'namecheap.purchase.target', response_body: { domain } });

  // PRICE GUARD: never spend more than the configured cap on a single domain.
  // Catches premium domains and any price surprise.
  const cap = config.namecheap.maxPrice();
  const cost = await estimateCost(ctx, selected);
  await ctx.logEvent({ level: 'info', endpoint: 'namecheap.price.estimate', response_body: { domain, estimated_cost: cost, cap, premium: selected.isPremium } });
  if (cost !== null && cost > cap) {
    throw new Error(`namecheap: ${domain} would cost ~$${cost.toFixed(2)}, over the $${cap.toFixed(2)} cap${selected.isPremium ? ' (premium domain)' : ''} - flagged, not purchased.`);
  }

  // Registrant = MMW agency WHOIS contact from config (one set for every domain).
  // Validate up front so a live purchase fails clearly instead of registering a
  // domain with placeholder/incomplete WHOIS (ICANN suspension risk).
  const r = config.namecheap.registrant();
  const missing = (['firstName', 'lastName', 'address1', 'city', 'state', 'postalCode', 'country', 'phone', 'email'] as const)
    .filter((k) => !r[k] || !String(r[k]).trim());
  if (missing.length > 0) {
    throw new Error(
      `namecheap: registrant not configured - set NAMECHEAP_REGISTRANT_* (missing: ${missing.join(', ')}). ` +
      `Refusing to register ${domain} with incomplete WHOIS.`,
    );
  }

  // One contact, mirrored across Registrant / Tech / Admin / AuxBilling.
  const contact: Record<string, string> = {
    FirstName: r.firstName,
    LastName: r.lastName,
    Address1: r.address1,
    City: r.city,
    StateProvince: r.state,
    PostalCode: r.postalCode,
    Country: r.country,
    Phone: r.phone,
    EmailAddress: r.email,
  };
  const registrantParams: Record<string, string> = { DomainName: domain, Years: '1' };
  for (const role of ['Registrant', 'Tech', 'Admin', 'AuxBilling']) {
    for (const [field, value] of Object.entries(contact)) {
      registrantParams[`${role}${field}`] = value;
    }
  }
  // Organization is optional; include it on all roles when set.
  if (r.organization && r.organization.trim()) {
    for (const role of ['Registrant', 'Tech', 'Admin', 'AuxBilling']) {
      registrantParams[`${role}OrganizationName`] = r.organization;
    }
  }

  const createRes = await callApi(
    ctx,
    ncUrl('namecheap.domains.create', registrantParams),
    'namecheap.domains.create',
  );

  const createXml = unwrapRelayXml(createRes.raw);
  const success = parseApiStatus(createXml);
  if (!success) {
    const errMsg = parseApiError(createXml) ?? 'unknown error from Namecheap';
    throw new Error(`namecheap.domains.create failed: ${errMsg}`);
  }

  // Persist the purchased domain as the run's working domain, and backfill the
  // original site into the profile so a later re-run derives the base from the
  // ORIGINAL site (not this purchased domain). Non-destructive: only sets
  // website_url if it wasn't already populated.
  const profile = (ctx.run.client_profile_json ?? {}) as Record<string, unknown>;
  const profilePatch = profile.website_url ? profile : { ...profile, website_url: siteSource(ctx) };
  await db()
    .from('onboarding_runs')
    .update({ domain, client_profile_json: profilePatch, updated_at: new Date().toISOString() })
    .eq('id', ctx.run.id);

  return { domain, purchased: true };
}

// ---------------------------------------------------------------------------
// Exported steps
// ---------------------------------------------------------------------------

export const namecheapSteps: Step[] = [
  {
    key: 'namecheap.purchase_domain',
    wave: 1,
    safetyClass: 'costly',
    dependsOn: ['profile.normalize_intake'],
    maxAttempts: 1,
    retryProfile: 'costly',
    isApplicable: () => true,
    runReal: purchaseDomainReal,
    runDry: purchaseDomainDry,
  },
];
