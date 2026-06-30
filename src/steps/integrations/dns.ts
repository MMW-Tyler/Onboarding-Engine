import type { Step, StepContext } from '../../types.js';
import { callApi } from '../../lib/http.js';
import { config } from '../../config.js';
import { namecheapUrl, unwrapRelayXml } from '../../lib/namecheap.js';
import { simulated } from './util.js';
import type { MailgunDnsRecord } from './mailgun.js';

/**
 * DNS workers (spec section 08: dns.ghl_records / dns.mailgun_records).
 *
 * Sets DNS host records on the freshly-purchased Namecheap domain. Both steps
 * are reversible-write.
 *
 * setHosts REPLACES every host record on the domain, so to avoid the two steps
 * clobbering each other (and to be safe to re-run) each step now:
 *   1. getHosts -> read the domain's current records,
 *   2. drops any existing record with the same Host+Type as one it's adding,
 *   3. setHosts the union (kept + new).
 * The two steps are also serialized (ghl depends on dns.mailgun_records) so they
 * never read-modify-write concurrently.
 *
 * The Mailgun records are NOT hardcoded: mailgun.add_domain stores the real
 * records (incl. the actual DKIM key) Mailgun returned on the run, and
 * dns.mailgun_records translates those into Namecheap host records.
 */

// ---------------------------------------------------------------------------
// Record types
// ---------------------------------------------------------------------------

interface DnsRecord {
  Type: string; // A | AAAA | CNAME | TXT | MX | URL | URL301 | FRAME | NS ...
  Host: string;
  Address: string;
  MXPref?: number;
  TTL?: number;
}

// ---------------------------------------------------------------------------
// Namecheap domain / URL helpers
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

/** Build the getHosts URL for a domain. */
function getHostsUrl(domain: string): string {
  const { sld, tld } = splitDomain(domain);
  return namecheapUrl('namecheap.domains.dns.getHosts', { SLD: sld, TLD: tld });
}

/**
 * Build the Namecheap setHosts URL for all provided records.
 * Each record is numbered 1..N and yields HostNameN/RecordTypeN/AddressN/
 * MXPrefN/TTLN params as required by the API.
 */
function setHostsUrl(domain: string, records: DnsRecord[]): string {
  const { sld, tld } = splitDomain(domain);
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
// XML parsing
// ---------------------------------------------------------------------------

/** Parse the <host .../> elements from a getHosts response into records. */
function parseHosts(xml: string): DnsRecord[] {
  const records: DnsRecord[] = [];
  const re = /<host\b([^>]*)\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const attrs = m[1]!;
    const attr = (name: string) => attrs.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i'))?.[1];
    const host = attr('Name');
    const type = attr('Type');
    const address = attr('Address');
    if (!host || !type) continue;
    records.push({
      Host: host,
      Type: type,
      Address: address ?? '',
      MXPref: attr('MXPref') ? Number(attr('MXPref')) : undefined,
      TTL: attr('TTL') ? Number(attr('TTL')) : undefined,
    });
  }
  return records;
}

/** Namecheap setHosts returns IsSuccess="true" inside the CommandResponse. */
function parseSetHostsSuccess(xml: string): boolean {
  return /IsSuccess\s*=\s*"true"/i.test(xml);
}

/** getHosts signals overall success with Status="OK". */
function parseApiStatus(xml: string): boolean {
  return /Status\s*=\s*"OK"/i.test(xml);
}

/** Extract first Error text from the response if present. */
function parseApiError(xml: string): string | null {
  const m = xml.match(/<Error[^>]*>([^<]*)<\/Error>/i);
  return m?.[1]?.trim() ?? null;
}

// ---------------------------------------------------------------------------
// Merge helper: getHosts -> union(kept, new) -> setHosts
// ---------------------------------------------------------------------------

/** Strip the registrable domain suffix to get the Namecheap relative Host. */
function relativeHost(fqdn: string, domain: string): string {
  const f = (fqdn ?? '').replace(/\.$/, '').toLowerCase();
  const d = domain.toLowerCase();
  if (!f || f === d) return '@';
  if (f.endsWith(`.${d}`)) return f.slice(0, -(d.length + 1));
  return f; // already relative, or unexpected - pass through
}

/**
 * Convert a Mailgun DNS record into a Namecheap host record. Mailgun's receiving
 * (MX) records omit `name` - they apply to the sending domain itself (mg.<domain>),
 * so fall back to that when name is absent.
 */
function mailgunToDns(rec: MailgunDnsRecord, domain: string): DnsRecord {
  const name = rec.name && rec.name.trim() ? rec.name : `mg.${domain}`;
  return {
    Type: (rec.record_type ?? 'TXT').toUpperCase(),
    Host: relativeHost(name, domain),
    Address: rec.value ?? '',
    MXPref: rec.priority ? Number(rec.priority) : undefined,
    TTL: 1800,
  };
}

/**
 * Apply records to the domain without clobbering unrelated host records:
 * read current hosts, drop any with the same Host+Type as an incoming record,
 * then setHosts the union.
 */
async function applyRecords(ctx: StepContext, domain: string, incoming: DnsRecord[], type: string): Promise<Record<string, unknown>> {
  const getRes = await callApi(ctx, getHostsUrl(domain), 'namecheap.domains.dns.getHosts');
  const getXml = unwrapRelayXml(getRes.raw);
  if (!parseApiStatus(getXml)) {
    throw new Error(`namecheap.domains.dns.getHosts failed (${type}): ${parseApiError(getXml) ?? 'unknown error'}`);
  }
  const existing = parseHosts(getXml);

  const incomingKeys = new Set(incoming.map((r) => `${r.Host.toLowerCase()}|${r.Type.toUpperCase()}`));
  const kept = existing.filter((r) => !incomingKeys.has(`${r.Host.toLowerCase()}|${r.Type.toUpperCase()}`));
  const merged = [...kept, ...incoming];

  const setRes = await callApi(ctx, setHostsUrl(domain, merged), 'namecheap.domains.dns.setHosts');
  const setXml = unwrapRelayXml(setRes.raw);
  if (!parseSetHostsSuccess(setXml)) {
    throw new Error(`namecheap.domains.dns.setHosts failed (${type}): ${parseApiError(setXml) ?? 'unknown error'}`);
  }

  return { domain, type, added: incoming.length, kept: kept.length, total: merged.length };
}

function requireDomain(ctx: StepContext): string {
  const d = ctx.run.domain as string | undefined;
  if (!d) throw new Error('dns: run has no domain yet');
  return d;
}

// ---------------------------------------------------------------------------
// Mailgun records (real values from the mailgun.add_domain step)
// ---------------------------------------------------------------------------

/** Structural placeholders, shown only in dry-run logging. */
const MAILGUN_PLACEHOLDER: DnsRecord[] = [
  { Type: 'TXT', Host: 'mg', Address: 'v=spf1 include:mailgun.org ~all', TTL: 1800 },
  { Type: 'TXT', Host: 'k1._domainkey.mg', Address: 'k=rsa; p=DKIM_FROM_MAILGUN', TTL: 1800 },
  { Type: 'MX', Host: 'mg', Address: 'mxa.mailgun.org', MXPref: 10, TTL: 1800 },
  { Type: 'MX', Host: 'mg', Address: 'mxb.mailgun.org', MXPref: 10, TTL: 1800 },
  { Type: 'CNAME', Host: 'email.mg', Address: 'mailgun.org', TTL: 1800 },
];

/** Read the records mailgun.add_domain stored on the run, converted for Namecheap. */
function mailgunRecordsFromRun(ctx: StepContext, domain: string): DnsRecord[] {
  const profile = (ctx.run.client_profile_json ?? {}) as Record<string, unknown>;
  const sending = (profile.mailgun_sending_dns ?? []) as MailgunDnsRecord[];
  const receiving = (profile.mailgun_receiving_dns ?? []) as MailgunDnsRecord[];
  return [...sending, ...receiving].map((r) => mailgunToDns(r, domain));
}

async function mailgunDnsReal(ctx: StepContext): Promise<Record<string, unknown>> {
  const domain = requireDomain(ctx);
  const records = mailgunRecordsFromRun(ctx, domain);
  if (records.length === 0) {
    throw new Error('dns.mailgun_records: no Mailgun records on the run - mailgun.add_domain must run (live) first');
  }
  return applyRecords(ctx, domain, records, 'mailgun');
}

async function mailgunDnsDry(ctx: StepContext): Promise<Record<string, unknown>> {
  const domain = requireDomain(ctx);
  // Prefer real records if mailgun already ran; else show the structural shape.
  const real = mailgunRecordsFromRun(ctx, domain);
  const records = real.length ? real : MAILGUN_PLACEHOLDER;
  await ctx.logEvent({ level: 'info', endpoint: 'dns.intended', response_body: records });
  return simulated({ domain, type: 'mailgun', records: records.length, source: real.length ? 'mailgun' : 'placeholder', note: 'dry-run: intended records logged, not applied' });
}

// ---------------------------------------------------------------------------
// GHL branded-domain record (from config; skips when not configured)
// ---------------------------------------------------------------------------

function ghlRecord(): DnsRecord | null {
  const { host, type, target } = config.ghl.brandedDns();
  if (!target || !target.trim()) return null;
  return { Type: type, Host: host, Address: target.trim(), TTL: 1800 };
}

async function ghlDnsReal(ctx: StepContext): Promise<Record<string, unknown>> {
  const domain = requireDomain(ctx);
  const rec = ghlRecord();
  if (!rec) {
    await ctx.logEvent({ level: 'warn', endpoint: 'dns.ghl_records', response_body: { skipped: 'GHL_BRANDED_DNS_TARGET not set' } });
    return { domain, type: 'ghl', skipped: true, reason: 'no_target_configured' };
  }
  return applyRecords(ctx, domain, [rec], 'ghl');
}

async function ghlDnsDry(ctx: StepContext): Promise<Record<string, unknown>> {
  const domain = requireDomain(ctx);
  const rec = ghlRecord();
  if (!rec) {
    return simulated({ domain, type: 'ghl', skipped: true, reason: 'no_target_configured', note: 'set GHL_BRANDED_DNS_TARGET to enable' });
  }
  await ctx.logEvent({ level: 'info', endpoint: 'dns.intended', response_body: [rec] });
  return simulated({ domain, type: 'ghl', records: 1, note: 'dry-run: intended records logged, not applied' });
}

// ---------------------------------------------------------------------------
// Exported steps
// ---------------------------------------------------------------------------

export const dnsSteps: Step[] = [
  {
    key: 'dns.mailgun_records',
    wave: 1,
    safetyClass: 'reversible-write',
    // After Mailgun, so we have the real DKIM/SPF/MX records to write.
    dependsOn: ['mailgun.add_domain'],
    maxAttempts: 5,
    retryProfile: 'flaky',
    isApplicable: () => true,
    runReal: mailgunDnsReal,
    runDry: mailgunDnsDry,
  },
  {
    key: 'dns.ghl_records',
    wave: 1,
    safetyClass: 'reversible-write',
    // Serialized after the Mailgun DNS write so the two never race on setHosts.
    dependsOn: ['dns.mailgun_records'],
    maxAttempts: 5,
    retryProfile: 'flaky',
    isApplicable: () => true,
    runReal: ghlDnsReal,
    runDry: ghlDnsDry,
  },
];
