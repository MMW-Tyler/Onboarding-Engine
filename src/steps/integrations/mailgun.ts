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
  name: string;          // FQDN, e.g. 'mg.example.com' or 'k1._domainkey.mg.example.com'
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
  return { domain: name, state, verified: state === 'active' };
}

async function verifyDomainDry(ctx: StepContext): Promise<Record<string, unknown>> {
  const base = baseUrl();
  const headers = authHeaders();
  const name = sendingDomain(ctx);
  const res = await callApi<any>(ctx, `${base}/v3/domains/${name}`, 'mailgun.domains.get', { method: 'GET', headers });
  return simulated({ domain: name, state: res.body?.domain?.state ?? 'unknown' });
}

export const mailgunSteps: Step[] = [
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
