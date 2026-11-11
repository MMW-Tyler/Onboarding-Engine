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
 *
 * dns.mailgun_records also publishes DMARC at _dmarc.<domain> (2026-11-05).
 * Without it, client mail passed SPF and DKIM for mg.<domain> and still landed
 * in spam with Gmail showing "DMARC: FAIL" (Dermagnify's first lead alert);
 * Google and Yahoo expect DMARC from senders. One record on the purchased domain
 * covers mail From: anything@<domain> AND anything@mg.<domain>, because a
 * receiver that finds no _dmarc.mg.<domain> falls back to the organizational
 * domain's record, and Mailgun's DKIM d=mg.<domain> aligns with a From of
 * <domain> under DMARC's default relaxed alignment. Unlike the Mailgun records
 * it is add-if-absent: a _dmarc record the domain already has (one added by
 * hand, or a policy someone tightened) is never replaced, and a second one is
 * never added, since two DMARC records means no policy at all.
 *
 * MX records need EmailType=MX (2026-11-11). Namecheap only applies custom MX
 * records when setHosts carries EmailType=MX; without it the MX rows are dropped
 * silently and the domain stays on "Email Forwarding". That left mg.<domain>
 * with no MX and no A record, and strict receivers (Paubox, Proofpoint) rejected
 * Mailgun mail with "sender's domain could not be found in DNS" while Gmail
 * accepted it. Every setHosts whose record set holds an MX now sends
 * EmailType=MX. Switching turns Namecheap's forwarding off, so a domain that
 * has forwarders (or runs MXE / Private Email / Gmail mail settings) is never
 * switched: its MX rows are left out and the step reports why. See planEmail.
 */

// ---------------------------------------------------------------------------
// Record types
// ---------------------------------------------------------------------------

export interface DnsRecord {
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

/** Build the getEmailForwarding URL for a domain. */
function getEmailForwardingUrl(domain: string): string {
  return namecheapUrl('namecheap.domains.dns.getEmailForwarding', { DomainName: domain });
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
function setHostsUrl(domain: string, records: DnsRecord[], emailType?: string): string {
  const { sld, tld } = splitDomain(domain);
  const extra: Record<string, string> = { SLD: sld, TLD: tld };
  // Without EmailType=MX Namecheap drops every MX row and keeps the domain on
  // its current mail setting (forwarding, for a new domain).
  if (emailType) extra.EmailType = emailType;
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

/** The domain's mail setting from a getHosts response: FWD | MX | MXE | OX | ... ('' if absent). */
export function parseEmailType(xml: string): string {
  return (xml.match(/<DomainDNSGetHostsResult\b[^>]*\bEmailType\s*=\s*"([^"]*)"/i)?.[1] ?? '').trim().toUpperCase();
}

/** Mailboxes forwarded by Namecheap email forwarding (getEmailForwarding's <Forward> rows). */
export function parseForwarders(xml: string): string[] {
  const out: string[] = [];
  const re = /<Forward\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1]!.match(/mailbox\s*=\s*"([^"]*)"/i)?.[1] ?? '(unnamed)');
  return out;
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

const keyOf = (r: DnsRecord) => `${r.Host.toLowerCase()}|${r.Type.toUpperCase()}`;

export interface MergedHosts {
  /** The full record set to setHosts. */
  merged: DnsRecord[];
  /** Existing records left exactly as they were. */
  kept: DnsRecord[];
  /** Records this write adds or replaces. */
  written: DnsRecord[];
  /** Existing records an add-if-absent record yielded to (a subset of kept). */
  deferred: DnsRecord[];
}

/**
 * The merge behind applyRecords. `replace` records win: any existing record
 * with the same Host+Type is dropped. `addIfAbsent` records only go in when the
 * domain has no record at that Host+Type yet; if it has one, that one stays and
 * is reported in `deferred`. Host matching ignores case, as DNS does.
 */
export function mergeHosts(existing: DnsRecord[], replace: DnsRecord[], addIfAbsent: DnsRecord[] = []): MergedHosts {
  const replaceKeys = new Set(replace.map(keyOf));
  const existingKeys = new Set(existing.map(keyOf));
  const optionalKeys = new Set(addIfAbsent.map(keyOf));
  const kept = existing.filter((r) => !replaceKeys.has(keyOf(r)));
  const fresh = addIfAbsent.filter((r) => !existingKeys.has(keyOf(r)) && !replaceKeys.has(keyOf(r)));
  const written = [...replace, ...fresh];
  const deferred = kept.filter((r) => optionalKeys.has(keyOf(r)));
  return { merged: [...kept, ...written], kept, written, deferred };
}

/**
 * Apply records to the domain without clobbering unrelated host records:
 * read current hosts, merge (see mergeHosts), then setHosts the union.
 */
async function applyRecords(
  ctx: StepContext,
  domain: string,
  incoming: DnsRecord[],
  type: string,
  addIfAbsent: DnsRecord[] = [],
): Promise<{ summary: Record<string, unknown>; deferred: DnsRecord[] }> {
  const getRes = await callApi(ctx, getHostsUrl(domain), 'namecheap.domains.dns.getHosts');
  const getXml = unwrapRelayXml(getRes.raw);
  if (!parseApiStatus(getXml)) {
    throw new Error(`namecheap.domains.dns.getHosts failed (${type}): ${parseApiError(getXml) ?? 'unknown error'}`);
  }
  const existing = parseHosts(getXml);

  const full = mergeHosts(existing, incoming, addIfAbsent);
  const deferred = full.deferred;
  const kept = full.kept;

  // MX rows only take effect with EmailType=MX, and switching to it turns off
  // Namecheap email forwarding. Decide before writing (see planEmail).
  const emailTypeBefore = parseEmailType(getXml);
  // "Wants MX" means THIS write adds MX rows. Existing MX rows on a domain that
  // is already in MX mode are kept by re-sending EmailType=MX (planEmail).
  const wantsMx = full.written.some(isMx);
  let forwarders: string[] | null = [];
  if (wantsMx && (emailTypeBefore === 'FWD' || emailTypeBefore === '')) {
    forwarders = await readForwarders(ctx, domain);
  }
  const mx = planEmail(domain, emailTypeBefore, wantsMx, forwarders);
  if (mx.warning) await ctx.logEvent({ level: 'warn', endpoint: 'dns.mx', response_body: mx });

  // Blocked: leave the MX rows out rather than send rows Namecheap would drop.
  const written = mx.action === 'blocked' ? full.written.filter((r) => !isMx(r)) : full.written;
  const merged = [...kept, ...written];

  const setRes = await callApi(ctx, setHostsUrl(domain, merged, mx.emailType), 'namecheap.domains.dns.setHosts');
  const setXml = unwrapRelayXml(setRes.raw);
  if (!parseSetHostsSuccess(setXml)) {
    throw new Error(`namecheap.domains.dns.setHosts failed (${type}): ${parseApiError(setXml) ?? 'unknown error'}`);
  }

  const { emailType: _sent, ...mxOut } = mx;
  return {
    summary: { domain, type, added: written.length, kept: kept.length, total: merged.length, ...(wantsMx ? { mx: mxOut } : {}) },
    deferred,
  };
}

const isMx = (r: DnsRecord) => r.Type.toUpperCase() === 'MX';

/**
 * Forwarders on the domain, or null when Namecheap would not say. null is
 * treated as "may have forwarders" (the switch is refused), never as none.
 */
async function readForwarders(ctx: StepContext, domain: string): Promise<string[] | null> {
  try {
    const res = await callApi(ctx, getEmailForwardingUrl(domain), 'namecheap.domains.dns.getEmailForwarding');
    const xml = unwrapRelayXml(res.raw);
    if (!parseApiStatus(xml)) {
      await ctx.logEvent({ level: 'warn', endpoint: 'dns.mx', parsed_error: `getEmailForwarding failed: ${parseApiError(xml) ?? 'unknown error'}` });
      return null;
    }
    return parseForwarders(xml);
  } catch (e) {
    await ctx.logEvent({ level: 'warn', endpoint: 'dns.mx', parsed_error: `getEmailForwarding failed: ${(e as Error).message}` });
    return null;
  }
}

export interface EmailPlan {
  /** none: no MX in the set. already_mx / switched_to_mx: MX rows written. blocked: MX rows left out. */
  action: 'none' | 'already_mx' | 'switched_to_mx' | 'blocked';
  /** EmailType to send on setHosts (undefined = leave the domain's mail setting alone). */
  emailType?: 'MX';
  email_type_before: string;
  forwarders?: string[];
  warning?: string;
}

/**
 * Decide whether a setHosts may carry EmailType=MX.
 *
 *  - already MX: always send MX again, whatever this write adds (omitting it
 *    could drop the MX rows the domain has, root ones included).
 *  - this write adds no MX: send nothing, the mail setting stays as it is.
 *  - FWD (or not reported) with no forwarders: switch to MX. True for every
 *    purchased <base>px.com domain so far; nothing is forwarding there.
 *  - FWD with forwarders, or forwarders unreadable: do NOT switch. Switching
 *    would silently stop that mail.
 *  - anything else (MXE, OX = Private Email, GMAIL...): do NOT switch. Someone
 *    set up real mail on the domain; MX mode would replace it.
 */
export function planEmail(domain: string, emailTypeBefore: string, wantsMx: boolean, forwarders: string[] | null): EmailPlan {
  const before = emailTypeBefore || 'unknown';
  if (emailTypeBefore === 'MX') return { action: wantsMx ? 'already_mx' : 'none', emailType: 'MX', email_type_before: before };
  if (!wantsMx) return { action: 'none', email_type_before: before };
  const fix = `mg.${domain} has no MX records, so strict receivers will reject mail sent from it. Fix by hand in Namecheap (Advanced DNS > Mail Settings > Custom MX: host mg, mxa.mailgun.org and mxb.mailgun.org, priority 10) once that mail is moved or confirmed unused.`;
  if (emailTypeBefore === 'FWD' || emailTypeBefore === '') {
    if (forwarders === null) {
      return { action: 'blocked', email_type_before: before, warning: `MX records NOT written: could not read ${domain}'s email forwarders, and switching Mail Settings to Custom MX would turn forwarding off. ${fix}` };
    }
    if (forwarders.length > 0) {
      return { action: 'blocked', email_type_before: before, forwarders, warning: `MX records NOT written: ${domain} forwards email for ${forwarders.join(', ')}, and switching Mail Settings to Custom MX would turn that off. ${fix}` };
    }
    return { action: 'switched_to_mx', emailType: 'MX', email_type_before: before, forwarders: [] };
  }
  return { action: 'blocked', email_type_before: before, warning: `MX records NOT written: ${domain}'s Mail Settings are "${emailTypeBefore}", not forwarding, so the engine left them alone. ${fix}` };
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
  const dmarc = dmarcRecord();
  if (dmarc.warning) await ctx.logEvent({ level: 'warn', endpoint: 'dns.dmarc', response_body: { warning: dmarc.warning } });

  const { summary, deferred } = await applyRecords(ctx, domain, records, 'mailgun', [dmarc.record]);

  const outcome = dmarcOutcome(domain, dmarc.record, deferred);
  if (outcome.warning) await ctx.logEvent({ level: 'warn', endpoint: 'dns.dmarc', response_body: outcome });
  return { ...summary, dmarc: outcome };
}

async function mailgunDnsDry(ctx: StepContext): Promise<Record<string, unknown>> {
  const domain = requireDomain(ctx);
  // Prefer real records if mailgun already ran; else show the structural shape.
  const real = mailgunRecordsFromRun(ctx, domain);
  const records = real.length ? real : MAILGUN_PLACEHOLDER;
  const dmarc = dmarcRecord();
  await ctx.logEvent({ level: 'info', endpoint: 'dns.intended', response_body: [...records, dmarc.record] });
  return simulated({
    domain,
    type: 'mailgun',
    records: records.length + 1,
    source: real.length ? 'mailgun' : 'placeholder',
    dmarc: {
      action: 'add_if_absent',
      host: `_dmarc.${domain}`,
      value: dmarc.record.Address,
      policy: dmarcPolicy(dmarc.record.Address),
      ...(dmarc.warning ? { warning: dmarc.warning } : {}),
    },
    mx: { action: 'switch_to_mx_unless_forwarders', note: 'live sends EmailType=MX with the mg MX rows, unless the domain has email forwarders or other mail settings' },
    note: 'dry-run: intended records logged, not applied (the _dmarc TXT is written only if the domain has none)',
  });
}

// ---------------------------------------------------------------------------
// DMARC record (add-if-absent, written by dns.mailgun_records)
// ---------------------------------------------------------------------------

/**
 * Monitoring-only policy: receivers evaluate DMARC (so aligned Mailgun mail
 * shows PASS) but take no action on failures. No rua= report address on
 * purpose: nobody reads aggregate reports today, the purchased domain has no
 * inbox to receive them, and an address on another domain only counts if that
 * domain also publishes a <domain>._report._dmarc authorization record per
 * client. Set DNS_DMARC_VALUE to change it for new runs.
 */
export const DMARC_DEFAULT = 'v=DMARC1; p=none;';
const DMARC_HOST = '_dmarc';

/** A TXT value is a DMARC record only if it starts with v=DMARC1 (RFC 7489 6.3). */
export function isDmarcValue(value: string | undefined): boolean {
  return /^\s*v\s*=\s*DMARC1\s*(;|$)/i.test(value ?? '');
}

/** The p= policy of a DMARC record (not sp=), lower-cased; undefined if none. */
export function dmarcPolicy(value: string | undefined): string | undefined {
  if (!isDmarcValue(value)) return undefined;
  return value!.match(/(?:^|;)\s*p\s*=\s*([a-z]+)/i)?.[1]?.toLowerCase();
}

/**
 * The DMARC TXT to publish at _dmarc.<domain>: DNS_DMARC_VALUE if it is a valid
 * record, else the default. A bad override falls back with a warning rather
 * than publishing a record receivers would ignore (or blocking the step).
 */
export function dmarcRecord(): { record: DnsRecord; warning?: string } {
  const configured = config.dns.dmarcValue().trim();
  const valid = !configured || ['none', 'quarantine', 'reject'].includes(dmarcPolicy(configured) ?? '');
  const value = configured && valid ? configured : DMARC_DEFAULT;
  return {
    record: { Type: 'TXT', Host: DMARC_HOST, Address: value, TTL: 1800 },
    ...(valid ? {} : { warning: `DNS_DMARC_VALUE "${configured}" is not a valid DMARC record (it must start with v=DMARC1 and set p=none|quarantine|reject); used "${DMARC_DEFAULT}" instead` }),
  };
}

/**
 * What happened to DMARC on this write. `deferred` holds the existing records
 * the add-if-absent DMARC record yielded to. Those are never changed, but a
 * problem with them is reported: receivers ignore TXT values that are not
 * v=DMARC1, and treat MORE than one DMARC record as no policy at all.
 */
export function dmarcOutcome(domain: string, rec: DnsRecord, deferred: DnsRecord[]): Record<string, unknown> & { warning?: string } {
  const host = `_dmarc.${domain}`;
  const existing = deferred.filter((r) => keyOf(r) === keyOf(rec));
  if (existing.length === 0) {
    return { action: 'added', host, value: rec.Address, policy: dmarcPolicy(rec.Address) };
  }
  const valid = existing.filter((r) => isDmarcValue(r.Address));
  let warning: string | undefined;
  if (valid.length === 0) {
    warning = `${host} has a TXT record that is not a DMARC record ("${existing[0]!.Address}"), so mail from this domain has no DMARC policy. Left alone: replace it in Namecheap with "${rec.Address}".`;
  } else if (valid.length > 1) {
    warning = `${host} has ${valid.length} DMARC records; receivers treat that as no policy. Left alone: delete all but one in Namecheap.`;
  }
  const shown = valid[0] ?? existing[0]!;
  return {
    action: 'kept_existing',
    host,
    value: shown.Address,
    policy: dmarcPolicy(shown.Address),
    ...(warning ? { warning } : {}),
  };
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
  return (await applyRecords(ctx, domain, [rec], 'ghl')).summary;
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
    // After Mailgun, so we have the real DKIM/SPF/MX records to write. Also
    // publishes _dmarc.<domain> if the domain has no DMARC record yet.
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
