import { randomBytes } from 'node:crypto';
import type { Step, StepContext } from '../../types.js';
import { db } from '../../supabase.js';
import { callApi } from '../../lib/http.js';
import { config } from '../../config.js';
import { simulated } from './util.js';

/**
 * Mailgun workers (spec section 08: mailgun.add_domain): register the client's
 * sending subdomain (mg.<run.domain>) with Mailgun. reversible-write: simulated
 * in dry-run via a read-safe probe (GET /v3/domains?limit=1).
 *
 * Base URL is region-dependent: us -> api.mailgun.net, eu -> api.eu.mailgun.net.
 * Auth is HTTP Basic with username 'api' and the MAILGUN_API_KEY as the password.
 */

function baseUrl(): string {
  const region = config.mailgun.region();
  return region === 'eu'
    ? 'https://api.eu.mailgun.net'
    : 'https://api.mailgun.net';
}

function authHeaders(): Record<string, string> {
  const credentials = Buffer.from('api:' + config.mailgun.apiKey()).toString('base64');
  return { authorization: 'Basic ' + credentials };
}

/** The sending subdomain for this run, e.g. mg.example.com */
function sendingDomain(ctx: StepContext): string {
  if (!ctx.run.domain) throw new Error('mailgun: run has no domain yet');
  return `mg.${ctx.run.domain}`;
}

// --- add_domain ---

async function addDomainReal(ctx: StepContext): Promise<Record<string, unknown>> {
  const base = baseUrl();
  const headers = authHeaders();
  const name = sendingDomain(ctx);

  // POST /v3/domains — 409 means domain already exists; tolerate it.
  await callApi(ctx, `${base}/v3/domains`, 'mailgun.domains.create', {
    method: 'POST',
    headers,
    form: { name },
    okStatuses: [409],
  });

  // GET /v3/domains/{domain} — fetch verification state + the exact DNS records
  // (real DKIM key, SPF, tracking CNAME, inbound MX) Mailgun wants on this domain.
  const res = await callApi<any>(ctx, `${base}/v3/domains/${name}`, 'mailgun.domains.get', {
    method: 'GET',
    headers,
  });

  const sending = (res.body?.sending_dns_records ?? []) as MailgunDnsRecord[];
  const receiving = (res.body?.receiving_dns_records ?? []) as MailgunDnsRecord[];

  // Persist the records so dns.mailgun_records writes the REAL values (not a
  // placeholder DKIM). client_profile_json is the non-sensitive run scratchpad.
  const existing = (ctx.run.client_profile_json ?? {}) as Record<string, unknown>;
  await db().from('onboarding_runs').update({
    client_profile_json: { ...existing, mailgun_sending_dns: sending, mailgun_receiving_dns: receiving },
    updated_at: new Date().toISOString(),
  }).eq('id', ctx.run.id);

  return {
    domain: name,
    state: res.body?.domain?.state ?? 'unknown',
    sending_records: sending.length,
    receiving_records: receiving.length,
  };
}

/** Shape of a Mailgun DNS record from the domains API. */
export interface MailgunDnsRecord {
  record_type: string;   // 'TXT' | 'CNAME' | 'MX'
  name?: string;         // FQDN, e.g. 'mg.example.com'; absent on the receiving (MX) records
  value: string;
  priority?: string;     // present on MX records
  valid?: string;
}

async function addDomainDry(ctx: StepContext): Promise<Record<string, unknown>> {
  const base = baseUrl();
  const headers = authHeaders();
  const name = sendingDomain(ctx);

  // Read-safe probe: list domains to confirm credentials are valid without mutating state.
  await callApi(ctx, `${base}/v3/domains?limit=1`, 'mailgun.domains.list', {
    method: 'GET',
    headers,
  });

  return simulated({ domain: name, state: 'simulated' });
}

/**
 * Create (or reset) a Mailgun SMTP credential and return its password. Used to
 * hand Warmup Inbox a sending login (info@mg.<domain>) for the assigned inbox.
 * Plain fetch (no step context) since it's called from an on-demand admin
 * endpoint, not a step run. A fresh password is set each call.
 */
export async function ensureSmtpCredential(sendingDomain: string, login: string): Promise<string> {
  const base = baseUrl();
  const headers = { ...authHeaders(), 'content-type': 'application/x-www-form-urlencoded' };
  const password = randomBytes(16).toString('hex');
  const form = (o: Record<string, string>) => new URLSearchParams(o).toString();

  // Create the credential (ignore "already exists"), then PUT to set our known
  // password so we can show it for pasting.
  await fetch(`${base}/v3/domains/${sendingDomain}/credentials`, { method: 'POST', headers, body: form({ login, password }) }).catch(() => {});
  const res = await fetch(`${base}/v3/domains/${sendingDomain}/credentials/${encodeURIComponent(login)}`, { method: 'PUT', headers, body: form({ password }) });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`mailgun credential update failed (${res.status}): ${t.slice(0, 200)}`);
  }
  return password;
}

// --- verify (ask Mailgun to re-check the DNS records we wrote) ---

async function verifyDomainReal(ctx: StepContext): Promise<Record<string, unknown>> {
  const base = baseUrl();
  const headers = authHeaders();
  const name = sendingDomain(ctx);

  // PUT /v3/domains/{domain}/verify - Mailgun re-checks DNS and flips the domain
  // to "active" once SPF/DKIM resolve. Right after we set DNS it's usually still
  // "unverified" (propagation), which is NOT a failure - we report state and let
  // the run proceed; Mailgun also keeps re-checking on its own.
  const res = await callApi<any>(ctx, `${base}/v3/domains/${name}/verify`, 'mailgun.domains.verify', {
    method: 'PUT',
    headers,
  });
  const state = res.body?.domain?.state ?? res.body?.state ?? 'unknown';
  if (state !== 'active') {
    await ctx.logEvent({ level: 'warn', endpoint: 'mailgun.domains.verify', parsed_error: `domain ${name} state=${state} (DNS may still be propagating; Mailgun will re-check)` });
  }

  // "active" only means SPF and DKIM resolved. It says nothing about the MX
  // records on mg.<domain>, and without those strict receivers reject the mail
  // (2026-11-11). So read the receiving records too and say when they are not
  // valid. The verify response carries them; fall back to a GET if it does not.
  let receiving = res.body?.receiving_dns_records as MailgunDnsRecord[] | undefined;
  if (!Array.isArray(receiving)) {
    const got = await callApi<any>(ctx, `${base}/v3/domains/${name}`, 'mailgun.domains.get', { method: 'GET', headers });
    receiving = (got.body?.receiving_dns_records ?? []) as MailgunDnsRecord[];
  }
  const mx = mxStatus(name, receiving);
  if (!mx.valid) await ctx.logEvent({ level: 'warn', endpoint: 'mailgun.mx', response_body: mx });

  return { domain: name, state, verified: state === 'active', mx_valid: mx.valid, ...(mx.valid ? {} : { mx_warning: mx.warning }) };
}

/**
 * Are both of Mailgun's MX records in place on the sending domain? Mailgun marks
 * each receiving record valid | unknown | invalid. Anything but "valid" on any
 * MX row (or no MX rows at all) counts as not in place.
 */
export function mxStatus(sendingDomainName: string, receiving: MailgunDnsRecord[]): { valid: boolean; records: { value: string; valid: string }[]; warning?: string } {
  const rows = receiving.filter((r) => (r.record_type ?? '').toUpperCase() === 'MX');
  const records = rows.map((r) => ({ value: r.value, valid: r.valid ?? 'unknown' }));
  const valid = rows.length >= 2 && records.every((r) => r.valid === 'valid');
  if (valid) return { valid, records };
  const bad = records.filter((r) => r.valid !== 'valid').map((r) => `${r.value} (${r.valid})`).join(', ');
  return {
    valid,
    records,
    warning: `Mailgun does not see valid MX records on ${sendingDomainName}${bad ? `: ${bad}` : ''}. Without them strict receivers (Paubox, Proofpoint) reject mail from this domain.`,
  };
}

async function verifyDomainDry(ctx: StepContext): Promise<Record<string, unknown>> {
  const base = baseUrl();
  const headers = authHeaders();
  const name = sendingDomain(ctx);
  const res = await callApi<any>(ctx, `${base}/v3/domains/${name}`, 'mailgun.domains.get', { method: 'GET', headers });
  return simulated({ domain: name, state: res.body?.domain?.state ?? 'unknown' });
}

// --- tracking (the MMW standard for every client sending domain) ---

/**
 * Mailgun tracking standard (Lori, Nov 2026): click tracking OFF, open tracking
 * ON, unsubscribes OFF, tracking protocol http.
 *
 * Why: the tracking host email.mg.<domain> has no TLS certificate, so the links
 * Mailgun rewrites for click tracking (and its unsubscribe links) are http and
 * mail clients flag them as "dangerous link". Open tracking is a pixel, which
 * is not flagged. A new Mailgun domain comes with click tracking ON, and the
 * engine never changed it until 2026-11-11.
 */
export const TRACKING_STANDARD = { click: false, open: true, unsubscribe: false, web_scheme: 'http' } as const;

export interface TrackingState {
  click: boolean | 'htmlonly' | null;
  open: boolean | null;
  unsubscribe: boolean | null;
  web_scheme: string | null;
}

const asBool = (v: unknown): boolean | null =>
  v === true || v === 'true' || v === 'yes' ? true : v === false || v === 'false' || v === 'no' ? false : null;

/** Read the four settings out of GET /tracking and GET /domains/{d} bodies. */
export function readTracking(trackingBody: any, domainBody: any): TrackingState {
  const t = trackingBody?.tracking ?? {};
  const click = t.click?.active;
  return {
    click: click === 'htmlonly' ? 'htmlonly' : asBool(click),
    open: asBool(t.open?.active),
    unsubscribe: asBool(t.unsubscribe?.active),
    web_scheme: typeof domainBody?.domain?.web_scheme === 'string' ? domainBody.domain.web_scheme : null,
  };
}

/** The settings that differ from the standard (an unreadable value counts as differing). */
export function trackingDiff(state: TrackingState): (keyof TrackingState)[] {
  return (Object.keys(TRACKING_STANDARD) as (keyof TrackingState)[]).filter((k) => state[k] !== TRACKING_STANDARD[k]);
}

async function getTracking(ctx: StepContext, name: string): Promise<TrackingState> {
  const base = baseUrl();
  const headers = authHeaders();
  const tracking = await callApi<any>(ctx, `${base}/v3/domains/${name}/tracking`, 'mailgun.tracking.get', { method: 'GET', headers });
  const domain = await callApi<any>(ctx, `${base}/v3/domains/${name}`, 'mailgun.domains.get', { method: 'GET', headers });
  return readTracking(tracking.body, domain.body);
}

async function trackingReal(ctx: StepContext): Promise<Record<string, unknown>> {
  const base = baseUrl();
  const headers = authHeaders();
  const name = sendingDomain(ctx);

  const before = await getTracking(ctx, name);
  const changed = trackingDiff(before);

  // Write only what differs, so a re-run on a domain already at the standard
  // makes no changes at all.
  for (const key of changed) {
    if (key === 'web_scheme') {
      await callApi(ctx, `${base}/v4/domains/${name}`, 'mailgun.domains.update', {
        method: 'PUT', headers, form: { web_scheme: TRACKING_STANDARD.web_scheme },
      });
    } else {
      await callApi(ctx, `${base}/v3/domains/${name}/tracking/${key}`, `mailgun.tracking.${key}`, {
        method: 'PUT', headers, form: { active: String(TRACKING_STANDARD[key]) },
      });
    }
  }

  // Read back: the step only succeeds when Mailgun shows the standard.
  const after = changed.length ? await getTracking(ctx, name) : before;
  const still = trackingDiff(after);
  if (still.length) {
    throw new Error(`mailgun.tracking: ${name} is still off the standard after the update: ${still.map((k) => `${k}=${after[k]}`).join(', ')}`);
  }
  return { domain: name, changed, before, after };
}

async function trackingDry(ctx: StepContext): Promise<Record<string, unknown>> {
  const name = sendingDomain(ctx);
  // The domain may not exist yet in a dry run (add_domain only simulates), so a
  // failed read is reported, not thrown.
  try {
    const before = await getTracking(ctx, name);
    const wouldChange = trackingDiff(before);
    return simulated({
      domain: name,
      current: before,
      would_change: wouldChange.map((k) => `${k}: ${before[k]} -> ${TRACKING_STANDARD[k]}`),
      note: wouldChange.length ? 'dry-run: differences reported, nothing written' : 'dry-run: already at the standard',
    });
  } catch (e) {
    return simulated({
      domain: name,
      would_set: TRACKING_STANDARD,
      note: `dry-run: could not read current tracking settings (${(e as Error).message.slice(0, 120)}); live sets the standard`,
    });
  }
}

export const mailgunSteps: Step[] = [
  {
    key: 'mailgun.tracking',
    wave: 1,
    safetyClass: 'reversible-write',
    // Right after the domain exists. Independent of DNS: these are settings on
    // the Mailgun domain, not records.
    dependsOn: ['mailgun.add_domain'],
    maxAttempts: 5,
    retryProfile: 'flaky',
    isApplicable: () => true,
    runReal: trackingReal,
    runDry: trackingDry,
  },
  {
    key: 'mailgun.add_domain',
    wave: 1,
    safetyClass: 'reversible-write',
    // Mailgun must run BEFORE DNS: creating the domain is what yields the real
    // DKIM key + sending records that dns.mailgun_records then writes.
    dependsOn: ['namecheap.purchase_domain'],
    maxAttempts: 5,
    retryProfile: 'flaky',
    isApplicable: () => true,
    runReal: addDomainReal,
    runDry: addDomainDry,
  },
  {
    key: 'mailgun.verify',
    wave: 1,
    safetyClass: 'reversible-write',
    // After the DNS records are written, ask Mailgun to verify them.
    dependsOn: ['dns.mailgun_records'],
    maxAttempts: 3,
    retryProfile: 'flaky',
    isApplicable: () => true,
    runReal: verifyDomainReal,
    runDry: verifyDomainDry,
  },
];
