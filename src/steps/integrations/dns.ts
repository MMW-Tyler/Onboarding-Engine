import type { Step, StepContext } from '../../types.js';
import { callApi } from '../../lib/http.js';
import { namecheapUrl } from '../../lib/namecheap.js';
import { simulated } from './util.js';

/**
 * DNS workers (spec section 08: dns.ghl_records / dns.mailgun_records).
 *
 * Sets DNS host records on the freshly-purchased Namecheap domain via the
 * namecheap.domains.dns.setHosts command. Both steps are reversible-write:
 * they overwrite host records but the domain can be reconfigured at any time.
 *
 * IMPORTANT setHosts caveat: this command REPLACES all host records on the
 * domain. For M4 this is acceptable because the domain is freshly purchased
 * and has no existing records. In production the two steps (GHL + Mailgun)
 * must be merged -- call getHosts first, union the new records with existing
 * ones, then call setHosts with the combined set so neither step clobbers the
 * other's records.
 * TODO(production): implement getHosts + merge before live use.
 */

// ---------------------------------------------------------------------------
// Record types
// ---------------------------------------------------------------------------

interface DnsRecord {
  Type: 'A' | 'CNAME' | 'TXT' | 'MX' | 'URL';
  Host: string;
  Address: string;
  MXPref?: number;
  TTL?: number;
}

// ---------------------------------------------------------------------------
// Record sets
// ---------------------------------------------------------------------------

/**
 * GoHighLevel branded-domain DNS records.
 * Sets a CNAME so the client's sub-domain resolves through GHL's CDN/proxy.
 *
 * TODO(production): confirm the real GHL branded-domain CNAME target with GHL
 * support or from the sub-account's Custom Domains settings. The value
 * 'clientclub.io' below is a placeholder derived from GHL documentation and
 * must be verified before these records go live.
 */
const GHL_RECORDS: DnsRecord[] = [
  // Primary branded domain CNAME (app.domain.com -> GHL endpoint).
  { Type: 'CNAME', Host: 'app', Address: 'clientclub.io', TTL: 1800 },
];

/**
 * Mailgun sending DNS records.
 *
 * TODO(production): The DKIM TXT value and exact subdomain hosts (mg vs root)
 * must come from the Mailgun add_domain API response for the specific sending
 * domain. The values below are correct structural placeholders for the 'mg'
 * subdomain sending strategy but DKIM_PLACEHOLDER must be replaced with the
 * key returned by Mailgun. Wire this step to run after a mailgun.add_domain
 * step and read ctx.run.mailgun_dkim_value (or similar) from the run row.
 */
const MAILGUN_RECORDS: DnsRecord[] = [
  // SPF record on the mg subdomain.
  { Type: 'TXT', Host: 'mg', Address: 'v=spf1 include:mailgun.org ~all', TTL: 1800 },

  // DKIM record -- value must come from Mailgun add_domain response.
  // TODO(production): replace DKIM_PLACEHOLDER with the real base64 public key.
  {
    Type: 'TXT',
    Host: 'k1._domainkey.mg',
    Address: 'k=rsa; p=DKIM_PLACEHOLDER',
    TTL: 1800,
  },

  // Mailgun inbound MX records (required for routing / tracking).
  { Type: 'MX', Host: 'mg', Address: 'mxa.mailgun.org', MXPref: 10, TTL: 1800 },
  { Type: 'MX', Host: 'mg', Address: 'mxb.mailgun.org', MXPref: 10, TTL: 1800 },

  // Tracking / click CNAME.
  { Type: 'CNAME', Host: 'email.mg', Address: 'mailgun.org', TTL: 1800 },
];

// ---------------------------------------------------------------------------
// Namecheap DNS URL builder
// ---------------------------------------------------------------------------

/**
 * Split a domain like 'example.co.uk' into SLD='example' and TLD='co.uk'.
 * We treat everything after the first dot as the TLD, which is correct for
 * all common registrar-managed TLDs (.com, .net, .co, .io, etc.).
 */
function splitDomain(domain: string): { sld: string; tld: string } {
  const dot = domain.indexOf('.');
  if (dot === -1) throw new Error(`dns: invalid domain (no dot): ${domain}`);
  return { sld: domain.slice(0, dot), tld: domain.slice(dot + 1) };
}

/**
 * Build the Namecheap setHosts URL for all provided records.
 * Each record is numbered 1..N and yields HostNameN/RecordTypeN/AddressN/
 * MXPrefN/TTLN params as required by the API.
 */
function setHostsUrl(domain: string, records: DnsRecord[]): string {
  const { sld, tld } = splitDomain(domain);

  // Command-specific params only; auth + ClientIp + relay routing are handled by
  // the shared namecheapUrl helper (src/lib/namecheap.ts).
  const extra: Record<string, string> = { SLD: sld, TLD: tld };
  records.forEach((rec, i) => {
    const n = String(i + 1);
    extra[`HostName${n}`] = rec.Host;
    extra[`RecordType${n}`] = rec.Type;
    extra[`Address${n}`] = rec.Address;
    extra[`MXPref${n}`] = rec.MXPref !== undefined ? String(rec.MXPref) : '10';
    extra[`TTL${n}`] = rec.TTL !== undefined ? String(rec.TTL) : '1800';
  });

  return namecheapUrl('namecheap.domains.dns.setHosts', extra);
}

// ---------------------------------------------------------------------------
// XML success check
// ---------------------------------------------------------------------------

/** Namecheap setHosts returns IsSuccess="true" inside the CommandResponse. */
function parseSetHostsSuccess(xml: string): boolean {
  return /IsSuccess\s*=\s*"true"/i.test(xml);
}

/** Extract first Error text from the response if present. */
function parseApiError(xml: string): string | null {
  const m = xml.match(/<Error[^>]*>([^<]*)<\/Error>/i);
  return m?.[1]?.trim() ?? null;
}

// ---------------------------------------------------------------------------
// Shared runReal / runDry builders
// ---------------------------------------------------------------------------

/**
 * Execute setHosts for the given record set against the domain on ctx.run.
 * Throws if the domain is missing or the API reports failure.
 */
async function setHostsReal(
  ctx: StepContext,
  records: DnsRecord[],
  type: 'ghl' | 'mailgun',
): Promise<Record<string, unknown>> {
  const domain = ctx.run.domain;
  if (!domain) throw new Error('dns: run has no domain yet');

  const url = setHostsUrl(domain, records);
  const res = await callApi(ctx, url, 'namecheap.domains.dns.setHosts');

  const success = parseSetHostsSuccess(res.raw);
  if (!success) {
    const errMsg = parseApiError(res.raw) ?? 'unknown error from Namecheap setHosts';
    throw new Error(`namecheap.domains.dns.setHosts failed (${type}): ${errMsg}`);
  }

  return { domain, records: records.length, type };
}

/**
 * Dry-run: log intended records via logEvent, return simulated output.
 * Never calls setHosts.
 */
async function setHostsDry(
  ctx: StepContext,
  records: DnsRecord[],
  type: 'ghl' | 'mailgun',
): Promise<Record<string, unknown>> {
  const domain = ctx.run.domain;
  if (!domain) throw new Error('dns: run has no domain yet');

  // Log the intended records so they are visible in step_events for review.
  await ctx.logEvent({
    level: 'info',
    endpoint: 'dns.intended',
    response_body: records,
  });

  return simulated({
    domain,
    records: records.length,
    type,
    note: 'dry-run: intended records logged, not applied',
  });
}

// ---------------------------------------------------------------------------
// Exported steps
// ---------------------------------------------------------------------------

export const dnsSteps: Step[] = [
  {
    key: 'dns.ghl_records',
    wave: 1,
    safetyClass: 'reversible-write',
    dependsOn: ['namecheap.purchase_domain'],
    maxAttempts: 5,
    retryProfile: 'flaky',
    isApplicable: () => true,
    runReal: (ctx) => setHostsReal(ctx, GHL_RECORDS, 'ghl'),
    runDry: (ctx) => setHostsDry(ctx, GHL_RECORDS, 'ghl'),
  },
  {
    key: 'dns.mailgun_records',
    wave: 1,
    safetyClass: 'reversible-write',
    dependsOn: ['namecheap.purchase_domain'],
    maxAttempts: 5,
    retryProfile: 'flaky',
    isApplicable: () => true,
    runReal: (ctx) => setHostsReal(ctx, MAILGUN_RECORDS, 'mailgun'),
    runDry: (ctx) => setHostsDry(ctx, MAILGUN_RECORDS, 'mailgun'),
  },
];
