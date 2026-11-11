import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { StepContext } from '../../types.js';
import { dnsSteps, mergeHosts, dmarcRecord, dmarcPolicy, dmarcOutcome, DMARC_DEFAULT, planEmail, parseEmailType, parseForwarders, type DnsRecord } from './dns.js';

// Namecheap is reached through callApi; capture every URL instead of calling it.
const nc = vi.hoisted(() => ({ calls: [] as string[], getHostsXml: '', forwardingXml: '' }));
const calls = nc.calls;
vi.mock('../../lib/http.js', () => ({
  callApi: async (_ctx: unknown, url: string, label: string) => {
    nc.calls.push(url);
    const raw = label.endsWith('getHosts')
      ? nc.getHostsXml
      : label.endsWith('getEmailForwarding')
      ? nc.forwardingXml
      : '<ApiResponse Status="OK"><CommandResponse><DomainDNSSetHostsResult Domain="dermagnifypx.com" IsSuccess="true" /></CommandResponse></ApiResponse>';
    return { status: 200, ok: true, body: null, raw };
  },
}));
// Skip the real URL builder's credential lookups; keep the params readable.
vi.mock('../../lib/namecheap.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/namecheap.js')>()),
  namecheapUrl: (command: string, extra: Record<string, string> = {}) =>
    `https://namecheap.test/xml.response?${new URLSearchParams({ Command: command, ...extra }).toString()}`,
}));

const DOMAIN = 'dermagnifypx.com';
const step = (key: string) => dnsSteps.find((s) => s.key === key)!;

/** The records a setHosts URL would write, as Host/Type/Address triples. */
function written(url: string): { Host: string; Type: string; Address: string }[] {
  const q = new URL(url).searchParams;
  const out: { Host: string; Type: string; Address: string }[] = [];
  for (let n = 1; q.has(`HostName${n}`); n++) {
    out.push({ Host: q.get(`HostName${n}`)!, Type: q.get(`RecordType${n}`)!, Address: q.get(`Address${n}`)! });
  }
  return out;
}

/** getHosts XML as Namecheap returns it. A new domain is on email forwarding (FWD). */
function hostsXml(records: { Name: string; Type: string; Address: string; MXPref?: number }[], emailType = 'FWD'): string {
  const hosts = records.map((r, i) => `<host HostId="${i + 1}" Name="${r.Name}" Type="${r.Type}" Address="${r.Address}" MXPref="${r.MXPref ?? 10}" TTL="1800" />`).join('');
  return `<ApiResponse Status="OK"><CommandResponse Type="namecheap.domains.dns.getHosts"><DomainDNSGetHostsResult Domain="${DOMAIN}" EmailType="${emailType}" IsUsingOurDNS="true">${hosts}</DomainDNSGetHostsResult></CommandResponse></ApiResponse>`;
}

function forwardingXml(forwards: Record<string, string> = {}): string {
  const rows = Object.entries(forwards).map(([box, to]) => `<Forward mailbox="${box}">${to}</Forward>`).join('');
  return `<ApiResponse Status="OK"><CommandResponse Type="namecheap.domains.dns.getEmailForwarding"><DomainDNSGetEmailForwardingResult Domain="${DOMAIN}">${rows}</DomainDNSGetEmailForwardingResult></CommandResponse></ApiResponse>`;
}

const setHostsCall = () => calls.find((u) => u.includes('setHosts'))!;
const param = (url: string, name: string) => new URL(url).searchParams.get(name);
/** MX rows a setHosts URL would write, with their priority. */
function mxRows(url: string): { Host: string; Address: string; MXPref: string }[] {
  const q = new URL(url).searchParams;
  const out: { Host: string; Address: string; MXPref: string }[] = [];
  for (let n = 1; q.has(`HostName${n}`); n++) {
    if (q.get(`RecordType${n}`) === 'MX') out.push({ Host: q.get(`HostName${n}`)!, Address: q.get(`Address${n}`)!, MXPref: q.get(`MXPref${n}`)! });
  }
  return out;
}

/** A run as mailgun.add_domain leaves it (records shaped like Mailgun's API). */
function ctxFor(): StepContext & { events: unknown[] } {
  const events: unknown[] = [];
  return {
    run: {
      id: 'run-dmarc',
      domain: DOMAIN,
      client_profile_json: {
        mailgun_sending_dns: [
          { record_type: 'TXT', name: `mg.${DOMAIN}`, value: 'v=spf1 include:mailgun.org ~all' },
          { record_type: 'TXT', name: `k1._domainkey.mg.${DOMAIN}`, value: 'k=rsa; p=MIGfMA0GCSqGSIb3' },
          { record_type: 'CNAME', name: `email.mg.${DOMAIN}`, value: 'mailgun.org' },
        ],
        mailgun_receiving_dns: [
          { record_type: 'MX', name: '', priority: '10', value: 'mxa.mailgun.org' },
          { record_type: 'MX', name: '', priority: '10', value: 'mxb.mailgun.org' },
        ],
      },
    },
    step: {},
    mode: 'live',
    attempt: 1,
    events,
    logEvent: async (e: unknown) => { events.push(e); },
  } as unknown as StepContext & { events: unknown[] };
}

const rec = (Host: string, Type: string, Address: string): DnsRecord => ({ Host, Type, Address, TTL: 1800 });

beforeEach(() => {
  calls.length = 0;
  nc.getHostsXml = hostsXml([]);
  nc.forwardingXml = forwardingXml();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('mergeHosts - replace vs add-if-absent', () => {
  const dmarc = rec('_dmarc', 'TXT', DMARC_DEFAULT);

  it('adds DMARC to a domain that has none, next to the replaced records', () => {
    const existing = [rec('@', 'A', '1.2.3.4'), rec('mg', 'TXT', 'old spf')];
    const m = mergeHosts(existing, [rec('mg', 'TXT', 'v=spf1 include:mailgun.org ~all')], [dmarc]);
    expect(m.merged).toEqual([rec('@', 'A', '1.2.3.4'), rec('mg', 'TXT', 'v=spf1 include:mailgun.org ~all'), dmarc]);
    expect(m.written).toHaveLength(2);
    expect(m.deferred).toEqual([]);
  });

  it('never replaces a DMARC record the domain already has, in any case', () => {
    const handSet = rec('_DMARC', 'TXT', 'v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com');
    const m = mergeHosts([handSet], [], [dmarc]);
    expect(m.merged).toEqual([handSet]);
    expect(m.written).toEqual([]);
    expect(m.deferred).toEqual([handSet]);
  });

  it('is idempotent: merging again over its own output changes nothing', () => {
    const replace = [rec('mg', 'TXT', 'v=spf1 include:mailgun.org ~all')];
    const first = mergeHosts([rec('@', 'A', '1.2.3.4')], replace, [dmarc]).merged;
    const second = mergeHosts(first, replace, [dmarc]).merged;
    // Same records; order is irrelevant to DNS (replaced records move to the end).
    const sorted = (rs: DnsRecord[]) => [...rs].sort((a, b) => `${a.Host}|${a.Type}`.localeCompare(`${b.Host}|${b.Type}`));
    expect(sorted(second)).toEqual(sorted(first));
    expect(second.filter((r) => r.Host === '_dmarc')).toHaveLength(1);
  });

  it('only defers to a record at the same host AND type', () => {
    // A CNAME at _dmarc is not a DMARC TXT; the TXT still goes in.
    const m = mergeHosts([rec('_dmarc', 'CNAME', 'elsewhere.example.com')], [], [dmarc]);
    expect(m.written).toEqual([dmarc]);
  });
});

describe('dmarcRecord - the value published', () => {
  it('defaults to a monitoring-only policy with no report address', () => {
    const { record, warning } = dmarcRecord();
    expect(record).toEqual({ Type: 'TXT', Host: '_dmarc', Address: 'v=DMARC1; p=none;', TTL: 1800 });
    expect(warning).toBeUndefined();
  });

  it('uses DNS_DMARC_VALUE when it is a valid record', () => {
    vi.stubEnv('DNS_DMARC_VALUE', 'v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com');
    expect(dmarcRecord().record.Address).toBe('v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com');
  });

  it('falls back to the default, with a warning, on a broken override', () => {
    for (const bad of ['p=none', 'v=DMARC1; sp=reject', 'v=DMARC1; p=maybe']) {
      vi.stubEnv('DNS_DMARC_VALUE', bad);
      const { record, warning } = dmarcRecord();
      expect(record.Address).toBe(DMARC_DEFAULT);
      expect(warning).toContain('not a valid DMARC record');
    }
  });

  it('reads p= and not sp=', () => {
    expect(dmarcPolicy('v=DMARC1; sp=reject; p=none')).toBe('none');
    expect(dmarcPolicy('v=DMARC1;p=Quarantine')).toBe('quarantine');
    expect(dmarcPolicy('v=spf1 include:mailgun.org ~all')).toBeUndefined();
  });
});

describe('dmarcOutcome - reporting on a record that was already there', () => {
  const ours = rec('_dmarc', 'TXT', DMARC_DEFAULT);

  it('flags a TXT at _dmarc that is not a DMARC record', () => {
    const o = dmarcOutcome(DOMAIN, ours, [rec('_dmarc', 'TXT', 'hello')]);
    expect(o.action).toBe('kept_existing');
    expect(o.warning).toContain('not a DMARC record');
  });

  it('flags two DMARC records, which receivers treat as no policy', () => {
    const o = dmarcOutcome(DOMAIN, ours, [rec('_dmarc', 'TXT', 'v=DMARC1; p=none;'), rec('_dmarc', 'TXT', 'v=DMARC1; p=reject;')]);
    expect(o.warning).toContain('2 DMARC records');
  });
});

describe('dns.mailgun_records - writes DMARC with the Mailgun records', () => {
  it('publishes _dmarc on a fresh domain without dropping unrelated records', async () => {
    nc.getHostsXml = hostsXml([
      { Name: '@', Type: 'URL', Address: 'http://www.dermagnifypx.com/' },
      { Name: 'go', Type: 'CNAME', Address: 'brand.ludicrous.cloud' },
    ]);
    const ctx = ctxFor();
    const out = await step('dns.mailgun_records').runReal(ctx);

    const set = calls.find((u) => u.includes('setHosts'))!;
    const records = written(set);
    expect(records).toContainEqual({ Host: '_dmarc', Type: 'TXT', Address: 'v=DMARC1; p=none;' });
    expect(records).toContainEqual({ Host: 'k1._domainkey.mg', Type: 'TXT', Address: 'k=rsa; p=MIGfMA0GCSqGSIb3' });
    expect(records).toContainEqual({ Host: 'go', Type: 'CNAME', Address: 'brand.ludicrous.cloud' });
    expect(records).toContainEqual({ Host: '@', Type: 'URL', Address: 'http://www.dermagnifypx.com/' });
    expect(records).toHaveLength(2 + 5 + 1);
    expect(out).toMatchObject({ added: 6, kept: 2, total: 8, dmarc: { action: 'added', host: '_dmarc.dermagnifypx.com', policy: 'none' } });
  });

  it('leaves an existing DMARC record exactly as it is on a re-run', async () => {
    nc.getHostsXml = hostsXml([
      { Name: 'mg', Type: 'TXT', Address: 'v=spf1 include:mailgun.org ~all' },
      { Name: '_dmarc', Type: 'TXT', Address: 'v=DMARC1; p=reject;' },
    ]);
    const out = await step('dns.mailgun_records').runReal(ctxFor());

    const dmarcRows = written(calls.find((u) => u.includes('setHosts'))!).filter((r) => r.Host === '_dmarc');
    expect(dmarcRows).toEqual([{ Host: '_dmarc', Type: 'TXT', Address: 'v=DMARC1; p=reject;' }]);
    expect(out).toMatchObject({ dmarc: { action: 'kept_existing', value: 'v=DMARC1; p=reject;', policy: 'reject' } });
    expect((out.dmarc as Record<string, unknown>).warning).toBeUndefined();
  });

  it('includes DMARC in the dry-run plan and calls nothing', async () => {
    const ctx = ctxFor();
    const out = await step('dns.mailgun_records').runDry(ctx);
    expect(calls).toEqual([]);
    expect(out).toMatchObject({ simulated: true, records: 6, dmarc: { action: 'add_if_absent', host: '_dmarc.dermagnifypx.com', value: 'v=DMARC1; p=none;' } });
    const intended = (ctx.events as { endpoint?: string; response_body?: unknown }[]).find((e) => e.endpoint === 'dns.intended');
    expect(intended?.response_body).toContainEqual({ Type: 'TXT', Host: '_dmarc', Address: 'v=DMARC1; p=none;', TTL: 1800 });
  });

  it('shows DMARC in the dry-run plan even before Mailgun has run', async () => {
    const ctx = ctxFor();
    (ctx.run as { client_profile_json: unknown }).client_profile_json = {};
    const out = await step('dns.mailgun_records').runDry(ctx);
    expect(out).toMatchObject({ source: 'placeholder', records: 6 });
  });
});

describe('dns.mailgun_records - MX records need EmailType=MX (2026-11-11)', () => {
  const MG_MX = [
    { Host: 'mg', Address: 'mxa.mailgun.org', MXPref: '10' },
    { Host: 'mg', Address: 'mxb.mailgun.org', MXPref: '10' },
  ];

  it('sends EmailType=MX with both mg MX rows at priority 10 on a new domain', async () => {
    const out = await step('dns.mailgun_records').runReal(ctxFor());
    const set = setHostsCall();
    expect(param(set, 'EmailType')).toBe('MX');
    expect(mxRows(set)).toEqual(MG_MX);
    // It asked about forwarders before switching the domain off forwarding.
    expect(calls.some((u) => u.includes('getEmailForwarding') && u.includes(`DomainName=${DOMAIN}`))).toBe(true);
    expect(out.mx).toEqual({ action: 'switched_to_mx', email_type_before: 'FWD', forwarders: [] });
  });

  it('does NOT switch a domain that forwards email, and leaves the MX rows out', async () => {
    nc.forwardingXml = forwardingXml({ info: 'owner@example.com', billing: 'owner@example.com' });
    const ctx = ctxFor();
    const out = await step('dns.mailgun_records').runReal(ctx);
    const set = setHostsCall();
    expect(param(set, 'EmailType')).toBeNull();
    expect(mxRows(set)).toEqual([]);
    // Everything else is still written.
    expect(written(set)).toContainEqual({ Host: 'mg', Type: 'TXT', Address: 'v=spf1 include:mailgun.org ~all' });
    expect(written(set)).toContainEqual({ Host: '_dmarc', Type: 'TXT', Address: 'v=DMARC1; p=none;' });
    expect(out).toMatchObject({ added: 4, mx: { action: 'blocked', forwarders: ['info', 'billing'] } });
    expect((out.mx as { warning: string }).warning).toContain('forwards email for info, billing');
    expect((ctx.events as { endpoint?: string; level?: string }[]).some((e) => e.endpoint === 'dns.mx' && e.level === 'warn')).toBe(true);
  });

  it('does NOT switch when the forwarders cannot be read', async () => {
    nc.forwardingXml = '<ApiResponse Status="ERROR"><Errors><Error Number="2019166">Domain not found</Error></Errors></ApiResponse>';
    const out = await step('dns.mailgun_records').runReal(ctxFor());
    expect(param(setHostsCall(), 'EmailType')).toBeNull();
    expect(mxRows(setHostsCall())).toEqual([]);
    expect(out.mx).toMatchObject({ action: 'blocked' });
  });

  it('does NOT switch a domain on other mail settings (Private Email, MXE)', async () => {
    nc.getHostsXml = hostsXml([], 'OX');
    const out = await step('dns.mailgun_records').runReal(ctxFor());
    expect(param(setHostsCall(), 'EmailType')).toBeNull();
    expect(mxRows(setHostsCall())).toEqual([]);
    expect(calls.some((u) => u.includes('getEmailForwarding'))).toBe(false);
    expect((out.mx as { warning: string }).warning).toContain('Mail Settings are "OX"');
  });

  it('keeps existing root MX records when the domain is already on custom MX', async () => {
    nc.getHostsXml = hostsXml([
      { Name: '@', Type: 'MX', Address: 'aspmx.l.google.com.', MXPref: 1 },
      { Name: 'mg', Type: 'MX', Address: 'mxa.mailgun.org.', MXPref: 10 },
    ], 'MX');
    const out = await step('dns.mailgun_records').runReal(ctxFor());
    const set = setHostsCall();
    expect(param(set, 'EmailType')).toBe('MX');
    expect(mxRows(set)).toEqual([{ Host: '@', Address: 'aspmx.l.google.com.', MXPref: '1' }, ...MG_MX]);
    expect(calls.some((u) => u.includes('getEmailForwarding'))).toBe(false);
    expect(out.mx).toEqual({ action: 'already_mx', email_type_before: 'MX' });
  });

  it('planEmail and the parsers', () => {
    expect(parseEmailType(hostsXml([], 'fwd'))).toBe('FWD');
    expect(parseEmailType('<DomainDNSGetHostsResult Domain="a.com" IsUsingOurDNS="true">')).toBe('');
    expect(parseForwarders(forwardingXml({ info: 'a@b.com' }))).toEqual(['info']);
    expect(parseForwarders(forwardingXml())).toEqual([]);
    expect(planEmail(DOMAIN, 'FWD', false, [])).toEqual({ action: 'none', email_type_before: 'FWD' });
    expect(planEmail(DOMAIN, '', true, []).action).toBe('switched_to_mx');
    expect(planEmail(DOMAIN, 'MX', false, []).emailType).toBe('MX');
  });
});

describe('dns.ghl_records - a later write must not undo the MX records', () => {
  it('re-sends EmailType=MX and the mg MX rows once the domain is on custom MX', async () => {
    nc.getHostsXml = hostsXml([
      { Name: 'mg', Type: 'MX', Address: 'mxa.mailgun.org.' },
      { Name: 'mg', Type: 'MX', Address: 'mxb.mailgun.org.' },
    ], 'MX');
    await step('dns.ghl_records').runReal(ctxFor());
    const set = setHostsCall();
    expect(param(set, 'EmailType')).toBe('MX');
    expect(mxRows(set)).toHaveLength(2);
  });

  it('sends no EmailType on a forwarding domain, as before', async () => {
    await step('dns.ghl_records').runReal(ctxFor());
    expect(param(setHostsCall(), 'EmailType')).toBeNull();
    expect(calls.some((u) => u.includes('getEmailForwarding'))).toBe(false);
  });
});

describe('dns.ghl_records - unchanged by the DMARC work', () => {
  it('keeps the _dmarc record when it writes the branded CNAME', async () => {
    nc.getHostsXml = hostsXml([{ Name: '_dmarc', Type: 'TXT', Address: 'v=DMARC1; p=none;' }]);
    const out = await step('dns.ghl_records').runReal(ctxFor());
    const records = written(calls.find((u) => u.includes('setHosts'))!);
    expect(records).toContainEqual({ Host: '_dmarc', Type: 'TXT', Address: 'v=DMARC1; p=none;' });
    expect(records).toContainEqual({ Host: 'go', Type: 'CNAME', Address: 'brand.ludicrous.cloud' });
    expect(out).toEqual({ domain: DOMAIN, type: 'ghl', added: 1, kept: 1, total: 2 });
  });
});
