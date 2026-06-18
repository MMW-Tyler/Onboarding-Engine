import type { Step, StepContext } from '../../types.js';
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

  // GET /v3/domains/{domain} — fetch verification state after create/upsert.
  const res = await callApi<any>(ctx, `${base}/v3/domains/${name}`, 'mailgun.domains.get', {
    method: 'GET',
    headers,
  });

  return {
    domain: name,
    state: res.body?.domain?.state ?? 'unknown',
  };
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

export const mailgunSteps: Step[] = [
  {
    key: 'mailgun.add_domain',
    wave: 1,
    safetyClass: 'reversible-write',
    dependsOn: ['dns.mailgun_records'],
    maxAttempts: 5,
    retryProfile: 'flaky',
    isApplicable: () => true,
    runReal: addDomainReal,
    runDry: addDomainDry,
  },
];
