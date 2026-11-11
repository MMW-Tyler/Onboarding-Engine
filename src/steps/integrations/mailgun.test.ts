import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StepContext } from '../../types.js';
import { mailgunSteps, mxStatus, readTracking, trackingDiff, TRACKING_STANDARD } from './mailgun.js';

// Mailgun is reached through callApi; record each call and answer from a fake domain.
const mg = vi.hoisted(() => ({
  calls: [] as { method: string; url: string; form?: Record<string, string> }[],
  tracking: { click: true as boolean | string, open: true, unsubscribe: true },
  webScheme: 'http',
  receiving: [] as { record_type: string; value: string; valid: string }[],
  state: 'active',
  ignoreWrites: false,
}));
vi.mock('../../lib/http.js', () => ({
  callApi: async (_ctx: unknown, url: string, _label: string, opts: { method?: string; form?: Record<string, string> } = {}) => {
    const method = opts.method ?? 'GET';
    mg.calls.push({ method, url, form: opts.form });
    const path = new URL(url).pathname;
    let body: unknown = {};
    if (method === 'PUT' && !mg.ignoreWrites) {
      const which = path.match(/\/tracking\/(click|open|unsubscribe)$/)?.[1] as 'click' | 'open' | 'unsubscribe' | undefined;
      if (which) mg.tracking[which] = opts.form!.active === 'true';
      else if (path.startsWith('/v4/domains/') && opts.form?.web_scheme) mg.webScheme = opts.form.web_scheme;
    }
    if (path.endsWith('/tracking')) {
      body = { tracking: { click: { active: mg.tracking.click }, open: { active: mg.tracking.open }, unsubscribe: { active: mg.tracking.unsubscribe } } };
    } else if (path.endsWith('/verify') || /^\/v3\/domains\/[^/]+$/.test(path)) {
      body = { domain: { state: mg.state, web_scheme: mg.webScheme }, receiving_dns_records: mg.receiving };
    }
    return { status: 200, ok: true, body, raw: JSON.stringify(body) };
  },
}));
vi.mock('../../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../config.js')>();
  return { ...real, config: { ...real.config, mailgun: { apiKey: () => 'test-key', region: () => 'us' } } };
});

const step = (key: string) => mailgunSteps.find((s) => s.key === key)!;
function ctxFor(): StepContext & { events: any[] } {
  const events: any[] = [];
  return {
    run: { id: 'run-1', domain: 'dermagnifypx.com', client_profile_json: {} },
    step: {}, mode: 'live', attempt: 1, events,
    logEvent: async (e: unknown) => { events.push(e); },
  } as unknown as StepContext & { events: any[] };
}
const writes = () => mg.calls.filter((c) => c.method === 'PUT');
const MX_OK = [
  { record_type: 'MX', value: 'mxa.mailgun.org', valid: 'valid' },
  { record_type: 'MX', value: 'mxb.mailgun.org', valid: 'valid' },
];

beforeEach(() => {
  mg.calls.length = 0;
  mg.tracking = { click: true, open: true, unsubscribe: true };
  mg.webScheme = 'http';
  mg.receiving = MX_OK;
  mg.state = 'active';
  mg.ignoreWrites = false;
});

describe('mailgun.tracking - the MMW tracking standard', () => {
  it('is click off, opens on, unsubscribe off, http', () => {
    expect(TRACKING_STANDARD).toEqual({ click: false, open: true, unsubscribe: false, web_scheme: 'http' });
  });

  it('turns click tracking and unsubscribes off on a new domain, and leaves the rest alone', async () => {
    const out = await step('mailgun.tracking').runReal(ctxFor());
    expect(writes().map((c) => [new URL(c.url).pathname, c.form])).toEqual([
      ['/v3/domains/mg.dermagnifypx.com/tracking/click', { active: 'false' }],
      ['/v3/domains/mg.dermagnifypx.com/tracking/unsubscribe', { active: 'false' }],
    ]);
    expect(out).toMatchObject({ domain: 'mg.dermagnifypx.com', changed: ['click', 'unsubscribe'], after: { click: false, open: true, unsubscribe: false, web_scheme: 'http' } });
  });

  it('fixes html-only click tracking, opens that are off, and an https tracking protocol', async () => {
    mg.tracking = { click: 'htmlonly', open: false, unsubscribe: false };
    mg.webScheme = 'https';
    const out = await step('mailgun.tracking').runReal(ctxFor());
    expect(writes().map((c) => [new URL(c.url).pathname, c.form])).toEqual([
      ['/v3/domains/mg.dermagnifypx.com/tracking/click', { active: 'false' }],
      ['/v3/domains/mg.dermagnifypx.com/tracking/open', { active: 'true' }],
      ['/v4/domains/mg.dermagnifypx.com', { web_scheme: 'http' }],
    ]);
    expect(out.changed).toEqual(['click', 'open', 'web_scheme']);
  });

  it('writes nothing on a domain already at the standard (safe to re-run)', async () => {
    mg.tracking = { click: false, open: true, unsubscribe: false };
    const out = await step('mailgun.tracking').runReal(ctxFor());
    expect(writes()).toEqual([]);
    expect(out.changed).toEqual([]);
  });

  it('fails when Mailgun still shows the old settings after the update', async () => {
    mg.ignoreWrites = true;
    await expect(step('mailgun.tracking').runReal(ctxFor())).rejects.toThrow(/still off the standard.*click=true/);
  });

  it('dry run reads, reports the differences and writes nothing', async () => {
    const out = await step('mailgun.tracking').runDry(ctxFor());
    expect(writes()).toEqual([]);
    expect(mg.calls.some((c) => c.url.endsWith('/v3/domains/mg.dermagnifypx.com/tracking'))).toBe(true);
    expect(out).toMatchObject({ simulated: true, would_change: ['click: true -> false', 'unsubscribe: true -> false'] });
  });

  it('treats a setting it cannot read as off the standard', () => {
    expect(trackingDiff(readTracking({}, {}))).toEqual(['click', 'open', 'unsubscribe', 'web_scheme']);
    expect(readTracking({ tracking: { click: { active: 'no' }, open: { active: 'yes' }, unsubscribe: { active: false } } }, { domain: { web_scheme: 'http' } }))
      .toEqual({ click: false, open: true, unsubscribe: false, web_scheme: 'http' });
  });

  it('runs right after the domain is created', () => {
    expect(step('mailgun.tracking').dependsOn).toEqual(['mailgun.add_domain']);
    expect(step('mailgun.tracking').safetyClass).toBe('reversible-write');
  });
});

describe('mailgun.verify - "active" does not mean the MX records exist', () => {
  it('reports valid MX records', async () => {
    const out = await step('mailgun.verify').runReal(ctxFor());
    expect(out).toEqual({ domain: 'mg.dermagnifypx.com', state: 'active', verified: true, mx_valid: true });
  });

  it('warns when the domain is active but an MX record is not valid', async () => {
    mg.receiving = [MX_OK[0]!, { record_type: 'MX', value: 'mxb.mailgun.org', valid: 'unknown' }];
    const ctx = ctxFor();
    const out = await step('mailgun.verify').runReal(ctx);
    expect(out).toMatchObject({ verified: true, mx_valid: false });
    expect(out.mx_warning).toContain('mxb.mailgun.org (unknown)');
    expect(ctx.events.some((e) => e.endpoint === 'mailgun.mx' && e.level === 'warn')).toBe(true);
  });

  it('mxStatus needs both records, each valid', () => {
    expect(mxStatus('mg.a.com', MX_OK).valid).toBe(true);
    expect(mxStatus('mg.a.com', [MX_OK[0]!]).valid).toBe(false);
    expect(mxStatus('mg.a.com', []).valid).toBe(false);
  });
});
