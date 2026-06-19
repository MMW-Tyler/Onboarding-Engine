import type { Step, StepContext } from '../../types.js';
import { db } from '../../supabase.js';
import { callApi } from '../../lib/http.js';
import { config } from '../../config.js';
import { namecheapUrl } from '../../lib/namecheap.js';
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
 * Determine the target domain for this run. Priority:
 *   1. ctx.run.domain (set by profile.normalize_intake from website_url)
 *   2. website_url from the client profile (strip scheme/path, lowercase)
 *   3. Slug of office_name + '.com' fallback
 */
function resolveDomain(ctx: StepContext): string {
  // 1. Prefer the pre-resolved domain on the run row.
  if (ctx.run.domain && typeof ctx.run.domain === 'string' && ctx.run.domain.trim()) {
    return ctx.run.domain.trim().toLowerCase();
  }

  const profile = profileOf(ctx.run);

  // 2. Derive from website_url in the profile.
  const websiteUrl = profile.website_url ?? '';
  if (websiteUrl) {
    try {
      const url = new URL(websiteUrl.startsWith('http') ? websiteUrl : `https://${websiteUrl}`);
      // hostname may include www. - keep it as the registrable domain.
      const host = url.hostname.replace(/^www\./, '');
      if (host && host.includes('.')) return host.toLowerCase();
    } catch {
      // fall through to slug approach
    }
  }

  // 3. Slug of office_name + '.com'.
  const name = (profile.office_name ?? ctx.run.client_name ?? 'client').toLowerCase();
  const slug = name.replace(/[^a-z0-9]+/g, '').slice(0, 50);
  return `${slug || 'client'}.com`;
}

// ---------------------------------------------------------------------------
// XML parsing helpers
// ---------------------------------------------------------------------------

/** Extract Available attribute from a DomainCheckResult XML element. */
function parseAvailable(xml: string): boolean {
  const m = xml.match(/Available\s*=\s*"(true|false)"/i);
  return m?.[1]?.toLowerCase() === 'true';
}

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
  const domain = resolveDomain(ctx);

  // domains.check - free availability check; never charges.
  const checkRes = await callApi(
    ctx,
    ncUrl('namecheap.domains.check', { DomainList: domain }),
    'namecheap.domains.check',
  );
  const available = parseAvailable(checkRes.raw);

  // users.getPricing - read-safe pricing lookup; never charges.
  const pricingRes = await callApi(
    ctx,
    ncUrl('namecheap.users.getPricing', { ProductType: 'DOMAIN' }),
    'namecheap.users.getPricing',
  );
  const price = parsePrice(pricingRes.raw);

  // NEVER call domains.create in dry mode.
  return simulated({
    domain,
    available,
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

  const domain = resolveDomain(ctx);
  const profile = profileOf(ctx.run);

  // TODO(production): Registrant contact details below are populated from the
  // client profile as best-effort placeholders. Before enabling live purchases
  // you MUST confirm all required registrant fields (RegistrantFirstName,
  // RegistrantLastName, RegistrantAddress1, RegistrantCity, RegistrantStateProvince,
  // RegistrantPostalCode, RegistrantCountry, RegistrantPhone, RegistrantEmailAddress)
  // are accurate and legally correct. Using placeholder values may result in
  // ICANN compliance failures or domain suspension.

  // Split office_name into first/last as a best-effort placeholder.
  const officeName = profile.office_name ?? ctx.run.client_name ?? 'Client';
  const nameParts = officeName.split(/\s+/);
  const firstName = nameParts[0] ?? 'Client';
  const lastName = nameParts.slice(1).join(' ') || 'Client';

  // Build registrant contact params from profile NAP fields.
  const registrantParams: Record<string, string> = {
    DomainName: domain,
    Years: '1',

    // Registrant
    RegistrantFirstName: firstName,
    RegistrantLastName: lastName,
    RegistrantAddress1: profile.nap_address ?? '123 Main St',
    RegistrantCity: profile.nap_city ?? 'Unknown',
    RegistrantStateProvince: profile.nap_state ?? 'CA',
    RegistrantPostalCode: profile.nap_zip ?? '00000',
    RegistrantCountry: 'US',
    RegistrantPhone: profile.nap_phone ?? '+1.0000000000',
    RegistrantEmailAddress: profile.doctor_email ?? 'contact@example.com',

    // Tech contact (mirror registrant)
    TechFirstName: firstName,
    TechLastName: lastName,
    TechAddress1: profile.nap_address ?? '123 Main St',
    TechCity: profile.nap_city ?? 'Unknown',
    TechStateProvince: profile.nap_state ?? 'CA',
    TechPostalCode: profile.nap_zip ?? '00000',
    TechCountry: 'US',
    TechPhone: profile.nap_phone ?? '+1.0000000000',
    TechEmailAddress: profile.doctor_email ?? 'contact@example.com',

    // Admin contact (mirror registrant)
    AdminFirstName: firstName,
    AdminLastName: lastName,
    AdminAddress1: profile.nap_address ?? '123 Main St',
    AdminCity: profile.nap_city ?? 'Unknown',
    AdminStateProvince: profile.nap_state ?? 'CA',
    AdminPostalCode: profile.nap_zip ?? '00000',
    AdminCountry: 'US',
    AdminPhone: profile.nap_phone ?? '+1.0000000000',
    AdminEmailAddress: profile.doctor_email ?? 'contact@example.com',

    // AuxBilling contact (mirror registrant)
    AuxBillingFirstName: firstName,
    AuxBillingLastName: lastName,
    AuxBillingAddress1: profile.nap_address ?? '123 Main St',
    AuxBillingCity: profile.nap_city ?? 'Unknown',
    AuxBillingStateProvince: profile.nap_state ?? 'CA',
    AuxBillingPostalCode: profile.nap_zip ?? '00000',
    AuxBillingCountry: 'US',
    AuxBillingPhone: profile.nap_phone ?? '+1.0000000000',
    AuxBillingEmailAddress: profile.doctor_email ?? 'contact@example.com',
  };

  const createRes = await callApi(
    ctx,
    ncUrl('namecheap.domains.create', registrantParams),
    'namecheap.domains.create',
  );

  const success = parseApiStatus(createRes.raw);
  if (!success) {
    const errMsg = parseApiError(createRes.raw) ?? 'unknown error from Namecheap';
    throw new Error(`namecheap.domains.create failed: ${errMsg}`);
  }

  // Persist the purchased domain back to the run row.
  await db()
    .from('onboarding_runs')
    .update({ domain, updated_at: new Date().toISOString() })
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
