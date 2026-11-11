import { resolveMx } from 'node:dns/promises';
import { db } from '../supabase.js';
import { config } from '../config.js';
import { namecheapUrl, unwrapRelayXml } from './namecheap.js';
import { parseEmailType, parseForwarders } from '../steps/integrations/dns.js';
import { readTracking, trackingDiff, mxStatus, type MailgunDnsRecord, type TrackingState } from '../steps/integrations/mailgun.js';

/**
 * Read-only audit of every client sending domain (2026-11-11): are the MX
 * records on mg.<domain> really there, what are the Namecheap mail settings,
 * does the domain forward email, and do the four Mailgun tracking settings match
 * the standard. Nothing here writes anything, to Namecheap, Mailgun or our DB,
 * and nothing is logged to step_events.
 *
 * Covers every live run that has a purchased domain, plus every mg.* domain in
 * the Mailgun account that no run knows about (set up by hand, or before the
 * engine existed).
 */

export interface DomainAudit {
  domain: string;
  sending_domain: string;
  source: 'run' | 'mailgun_only';
  client?: string | null;
  run_id?: string;
  /** Public DNS: the MX hosts on mg.<domain> right now. */
  mg_mx_dns: string[];
  mg_mx_present: boolean;
  namecheap: { email_type?: string; mg_mx_rows?: number; forwarders?: string[]; error?: string };
  mailgun: { state?: string; mx_valid?: boolean; tracking?: TrackingState; off_standard?: string[]; error?: string };
  /** What a backfill would do, or why it would not. */
  verdict: 'clean' | 'needs_backfill' | 'skip_has_forwarders' | 'skip_other_mail_settings' | 'check_by_hand';
  notes: string[];
}

const MAILGUN_MX = ['mxa.mailgun.org', 'mxb.mailgun.org'];

function mailgunBase(): string {
  return config.mailgun.region() === 'eu' ? 'https://api.eu.mailgun.net' : 'https://api.mailgun.net';
}

async function mailgunGet(path: string): Promise<any> {
  const res = await fetch(`${mailgunBase()}${path}`, {
    headers: { authorization: 'Basic ' + Buffer.from('api:' + config.mailgun.apiKey()).toString('base64') },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Mailgun ${res.status}`);
  return res.json();
}

async function namecheapGet(command: string, extra: Record<string, string>): Promise<string> {
  const res = await fetch(namecheapUrl(command, extra), { signal: AbortSignal.timeout(30000) });
  const xml = unwrapRelayXml(await res.text());
  if (!/Status\s*=\s*"OK"/i.test(xml)) {
    throw new Error(xml.match(/<Error[^>]*>([^<]*)<\/Error>/i)?.[1]?.trim() ?? `Namecheap HTTP ${res.status}`);
  }
  return xml;
}

async function dnsMx(host: string): Promise<string[]> {
  try {
    return (await resolveMx(host)).map((r) => r.exchange.toLowerCase().replace(/\.$/, '')).sort();
  } catch {
    return [];
  }
}

/** Every mg.* sending domain in the Mailgun account. */
async function mailgunSendingDomains(): Promise<string[]> {
  const names: string[] = [];
  for (let skip = 0; skip < 5000; skip += 100) {
    const body = await mailgunGet(`/v3/domains?limit=100&skip=${skip}`);
    const items = (body?.items ?? []) as { name?: string }[];
    for (const d of items) if (d.name) names.push(d.name.toLowerCase());
    if (items.length < 100) break;
  }
  return names.filter((n) => n.startsWith('mg.'));
}

async function auditOne(base: Pick<DomainAudit, 'domain' | 'source' | 'client' | 'run_id'>): Promise<DomainAudit> {
  const sending = `mg.${base.domain}`;
  const notes: string[] = [];
  const mxDns = await dnsMx(sending);
  const mxPresent = MAILGUN_MX.every((h) => mxDns.includes(h));

  const namecheap: DomainAudit['namecheap'] = {};
  try {
    const dot = base.domain.indexOf('.');
    const xml = await namecheapGet('namecheap.domains.dns.getHosts', { SLD: base.domain.slice(0, dot), TLD: base.domain.slice(dot + 1) });
    namecheap.email_type = parseEmailType(xml) || 'unknown';
    namecheap.mg_mx_rows = (xml.match(/<host\b[^>]*\bName\s*=\s*"mg"[^>]*\bType\s*=\s*"MX"/gi) ?? []).length;
    if (namecheap.email_type === 'FWD' || namecheap.email_type === 'unknown') {
      namecheap.forwarders = parseForwarders(await namecheapGet('namecheap.domains.dns.getEmailForwarding', { DomainName: base.domain }));
    }
  } catch (e) {
    namecheap.error = (e as Error).message.slice(0, 200);
  }

  const mailgun: DomainAudit['mailgun'] = {};
  try {
    const domainBody = await mailgunGet(`/v3/domains/${sending}`);
    const trackingBody = await mailgunGet(`/v3/domains/${sending}/tracking`);
    mailgun.state = domainBody?.domain?.state;
    mailgun.mx_valid = mxStatus(sending, (domainBody?.receiving_dns_records ?? []) as MailgunDnsRecord[]).valid;
    mailgun.tracking = readTracking(trackingBody, domainBody);
    mailgun.off_standard = trackingDiff(mailgun.tracking).map((k) => `${k}=${mailgun.tracking![k]}`);
  } catch (e) {
    mailgun.error = (e as Error).message.slice(0, 200);
  }

  const trackingOk = !mailgun.error && (mailgun.off_standard?.length ?? 1) === 0;
  let verdict: DomainAudit['verdict'];
  if (mxPresent && trackingOk) {
    verdict = 'clean';
  } else if (namecheap.error || mailgun.error) {
    verdict = 'check_by_hand';
    if (namecheap.error) notes.push(`Namecheap: ${namecheap.error}`);
    if (mailgun.error) notes.push(`Mailgun: ${mailgun.error}`);
  } else if (!mxPresent && (namecheap.forwarders?.length ?? 0) > 0) {
    verdict = 'skip_has_forwarders';
    notes.push(`forwards email for ${namecheap.forwarders!.join(', ')}`);
  } else if (!mxPresent && !['FWD', 'MX', 'unknown'].includes(namecheap.email_type ?? '')) {
    verdict = 'skip_other_mail_settings';
    notes.push(`Mail Settings are ${namecheap.email_type}`);
  } else {
    verdict = 'needs_backfill';
  }
  if (!mxPresent) notes.push('no Mailgun MX on mg host');
  if (mailgun.off_standard?.length) notes.push(`tracking off standard: ${mailgun.off_standard.join(', ')}`);
  if (base.source === 'mailgun_only' && verdict === 'needs_backfill') {
    notes.push('no engine run for this domain: a backfill cannot retry a step, fix by hand or ask for a one-off');
  }

  return { ...base, sending_domain: sending, mg_mx_dns: mxDns, mg_mx_present: mxPresent, namecheap, mailgun, verdict, notes };
}

export async function auditEmailStack(): Promise<{ generated_at: string; total: number; by_verdict: Record<string, number>; domains: DomainAudit[] }> {
  // Live runs with a purchased domain; the newest run wins when a domain repeats.
  const { data: runs, error } = await db()
    .from('onboarding_runs')
    .select('id, client_name, domain, mode, created_at')
    .eq('mode', 'live')
    .not('domain', 'is', null)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`auditEmailStack: ${error.message}`);

  const targets = new Map<string, Pick<DomainAudit, 'domain' | 'source' | 'client' | 'run_id'>>();
  for (const r of runs ?? []) {
    const domain = String(r.domain).toLowerCase();
    if (!targets.has(domain)) targets.set(domain, { domain, source: 'run', client: r.client_name as string | null, run_id: r.id as string });
  }
  let listError: string | undefined;
  try {
    for (const name of await mailgunSendingDomains()) {
      const domain = name.slice(3);
      if (!targets.has(domain)) targets.set(domain, { domain, source: 'mailgun_only' });
    }
  } catch (e) {
    listError = (e as Error).message;
  }

  // One at a time: the Namecheap relay and API are slow and rate limited.
  const domains: DomainAudit[] = [];
  for (const t of targets.values()) domains.push(await auditOne(t));

  const by_verdict: Record<string, number> = {};
  for (const d of domains) by_verdict[d.verdict] = (by_verdict[d.verdict] ?? 0) + 1;
  return {
    generated_at: new Date().toISOString(),
    total: domains.length,
    by_verdict,
    ...(listError ? { mailgun_list_error: listError } : {}),
    domains,
  };
}
