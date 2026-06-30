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
type CheckOutcome = { available: true } | { available: false } | { error: string };

/**
 * Interpret a domains.check response. A real result has a DomainCheckResult with
 * Available="true|false"; anything else (Status="ERROR", no result element,
 * relay mangling) is surfaced as an error rather than silently read as "taken".
 */
function checkOutcome(rawXml: string): CheckOutcome {
  const xml = unwrapRelayXml(rawXml);
  if (/Status\s*=\s*"ERROR"/i.test(xml)) {
    return { error: parseApiError(xml) ?? 'Namecheap API error' };
  }
  const m = xml.match(/<DomainCheckResult[^>]*\bAvailable\s*=\s*"(true|false)"/i);
  if (!m) {
    return { error: `unexpected domains.check response (no DomainCheckResult); first 200 chars: ${xml.slice(0, 200)}` };
  }
  return m[1]!.toLowerCase() === 'true' ? { available: true } : { available: false };
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
  for (const domain of candidates) {
    const checkRes = await callApi(
      ctx,
      ncUrl('namecheap.domains.check', { DomainList: domain }),
      'namecheap.domains.check',
    );
    const outcome = checkOutcome(checkRes.raw);
    if ('error' in outcome) checked.push({ domain, available: null, error: outcome.error });
    else checked.push({ domain, available: outcome.available });
  }
  const wouldPurchase = checked.find((c) => c.available === true)?.domain ?? null;

  // users.getPricing - read-safe pricing lookup; never charges.
  const pricingRes = await callApi(
    ctx,
    ncUrl('namecheap.users.getPricing', { ProductType: 'DOMAIN' }),
    'namecheap.users.getPricing',
  );
  const price = parsePrice(unwrapRelayXml(pricingRes.raw));

  // NEVER call domains.create in dry mode.
  return simulated({
    candidates: checked,
    would_purchase: wouldPurchase,
    price,
    note: 'dry-run: check + pricing only, no purchase',
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
      break;
    }
  }
  if (!domain) {
    throw new Error(`namecheap: neither candidate is available to purchase (tried: ${candidates.join(', ')}).`);
  }
  await ctx.logEvent({ level: 'info', endpoint: 'namecheap.purchase.target', response_body: { domain } });

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
