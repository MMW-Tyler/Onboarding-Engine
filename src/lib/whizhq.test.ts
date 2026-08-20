import { describe, it, expect } from 'vitest';
import { HttpError } from './http.js';
import {
  bootstrapFinished,
  classifyWhizError,
  clientTypeFor,
  crawlFailed,
  isDeadCrawl,
  pollProgressLine,
  summarizeBootstrap,
  WHIZ_AMBIGUOUS,
  WHIZ_SKIPPABLE,
  type WhizAutofillStep,
  type WhizPoll,
} from './whizhq.js';

const step = (over: Partial<WhizAutofillStep> = {}): WhizAutofillStep => ({
  status: 'complete',
  applied: [],
  skipped: [],
  notes: [],
  pagesAnalyzed: null,
  error: null,
  ...over,
});

const httpErr = (status: number, body: unknown) => new HttpError(`x: HTTP ${status}`, status, body);

describe('classifyWhizError', () => {
  it('reads WhizHQ\'s documented failure bodies', () => {
    expect(classifyWhizError(httpErr(401, { error: 'Invalid automation key' })).kind).toBe('auth');
    expect(classifyWhizError(httpErr(503, { error: 'Automation not configured' })).kind).toBe('not_deployed');
    expect(classifyWhizError(httpErr(400, { error: 'no crawl target' })).kind).toBe('bad_request');
    expect(classifyWhizError(httpErr(409, { error: 'already running', crawlId: 'c1' })).kind).toBe('conflict');
    expect(classifyWhizError(httpErr(500, { error: 'boom' })).kind).toBe('server');
  });

  it('surfaces the API\'s own error message, not the HTTP wrapper text', () => {
    expect(classifyWhizError(httpErr(400, { error: 'unknown ae_email' })).message).toBe('unknown ae_email');
  });

  // The one genuinely ambiguous status: an un-deployed route and an unknown
  // client id are both 404, and they need opposite handling (skip vs. report).
  it('tells an un-deployed route apart from an unknown client id', () => {
    const notDeployed = classifyWhizError(httpErr(404, '<!DOCTYPE html><body>Cannot POST /api/automation/site-intelligence/bootstrap</body>'));
    expect(notDeployed.kind).toBe('not_deployed');

    const missingClient = classifyWhizError(httpErr(404, { error: 'client not found' }));
    expect(missingClient.kind).toBe('not_found');
    expect(missingClient.message).toBe('client not found');
  });

  it('treats a network error / timeout as ambiguous, never as "nothing happened"', () => {
    const f = classifyWhizError(new HttpError('onboard: network error: aborted', 0, null));
    expect(f.kind).toBe('server');
    expect(WHIZ_AMBIGUOUS.has(f.kind)).toBe(true);

    const plain = classifyWhizError(new Error('socket hang up'));
    expect(plain.kind).toBe('server');
    expect(plain.status).toBe(0);
  });

  it('classifies only "not deployed" as skippable', () => {
    expect(WHIZ_SKIPPABLE.has('not_deployed')).toBe(true);
    expect(WHIZ_SKIPPABLE.has('auth')).toBe(false);
    expect(WHIZ_SKIPPABLE.has('server')).toBe(false);
    expect(WHIZ_AMBIGUOUS.has('bad_request')).toBe(false);
  });
});

describe('bootstrapFinished', () => {
  it('is not finished while the crawl runs', () => {
    expect(bootstrapFinished({ crawl: { status: 'running' }, clientInfo: step({ status: 'pending' }) })).toBe(false);
  });

  it('is not finished while either autofill step is still working', () => {
    const done = { crawl: { status: 'done' as const } };
    expect(bootstrapFinished({ ...done, clientInfo: step({ status: 'running' }), brandVoice: step() })).toBe(false);
    expect(bootstrapFinished({ ...done, clientInfo: step(), brandVoice: step({ status: 'pending' }) })).toBe(false);
  });

  it('is finished when the crawl is done and both steps settled', () => {
    expect(bootstrapFinished({
      crawl: { status: 'done' },
      clientInfo: step({ status: 'complete' }),
      brandVoice: step({ status: 'failed' }),
    })).toBe(true);
  });

  // A failed crawl is finished, not something to keep polling: the steps come
  // back `skipped` because they never got to run.
  it('is finished when the crawl failed', () => {
    expect(bootstrapFinished({
      crawl: { status: 'error', error: 'no usable pages' },
      clientInfo: step({ status: 'skipped' }),
      brandVoice: step({ status: 'skipped' }),
    })).toBe(true);
    expect(bootstrapFinished({ crawl: { status: 'cancelled' } })).toBe(true);
  });
});

describe('isDeadCrawl', () => {
  const dead: WhizPoll = { crawl: { status: 'running', live: false } };

  it('spots a crawl whose process restarted (running, nothing live)', () => {
    expect(isDeadCrawl(dead, 3)).toBe(true);
  });

  // A crawl that was just queued may not have registered a live job yet, so an
  // early `live: false` must not be read as death.
  it('does not declare a freshly-started crawl dead', () => {
    expect(isDeadCrawl(dead, 1)).toBe(false);
    expect(isDeadCrawl(dead, 2)).toBe(false);
  });

  // Finished jobs stay live for ~10 minutes, so `live` alone proves nothing.
  it('is not fooled by a live crawl or a finished one', () => {
    expect(isDeadCrawl({ crawl: { status: 'running', live: true } }, 10)).toBe(false);
    expect(isDeadCrawl({ crawl: { status: 'done', live: true } }, 10)).toBe(false);
  });
});

describe('summarizeBootstrap', () => {
  it('reports a blocked crawl as a failure, never as a completed one', () => {
    const s = summarizeBootstrap(
      { crawl: { status: 'error', targetUrl: 'https://foo.com', error: 'no usable pages', pageCount: 0 } },
      'foo.com',
    );
    expect(s.headline).toContain('could not crawl');
    expect(s.headline).toContain('no usable pages');
    expect(s.detail.join(' ')).toContain('still empty');
    expect(s.facts.pages).toBe(0);
    expect(crawlFailed({ crawl: { status: 'error' } })).toBe(true);
  });

  it('names the fields it filled and flags them as unverified', () => {
    const s = summarizeBootstrap({
      crawl: { status: 'done', targetUrl: 'https://foo.com', pageCount: 84, errorCount: 2 },
      clientInfo: step({ applied: ['practiceName', 'phone'], skipped: [{ field: 'bookingUrl', reason: 'already filled in' }] }),
      brandVoice: step({ pagesAnalyzed: 22 }),
    }, 'foo.com');

    expect(s.headline).toBe('🔍 WhizHQ crawled 84 pages of https://foo.com.');
    const body = s.detail.join('\n');
    expect(body).toContain('practiceName, phone');
    expect(body).toContain('bookingUrl');
    expect(body).toContain('22 content pages');
    expect(body).toContain('2 pages errored');
    expect(body).toContain('unverified');
    expect(s.facts).toMatchObject({
      pages: 84,
      client_info_applied: ['practiceName', 'phone'],
      brand_voice_status: 'complete',
      brand_voice_pages: 22,
    });
  });

  it('does not claim anything is unverified when nothing was written', () => {
    const s = summarizeBootstrap({
      crawl: { status: 'done', targetUrl: 'https://foo.com', pageCount: 5 },
      clientInfo: step({ applied: [] }),
      brandVoice: step({ status: 'failed', error: 'model timeout' }),
    }, 'foo.com');
    const body = s.detail.join('\n');
    expect(body).toContain('every field it reads was already set');
    expect(body).toContain('model timeout');
    expect(body).not.toContain('unverified');
  });

  it('handles the singular page and a missing target url', () => {
    const s = summarizeBootstrap({ crawl: { status: 'done', pageCount: 1 } }, 'foo.com');
    expect(s.headline).toBe('🔍 WhizHQ crawled 1 page of foo.com.');
  });
});

describe('pollProgressLine', () => {
  it('reads as progress, so 30 minutes of waiting is not 30 minutes of errors', () => {
    const line = pollProgressLine(
      { crawl: { status: 'running', pageCount: 42 }, clientInfo: step({ status: 'pending' }), brandVoice: step({ status: 'pending' }) },
      7,
      32,
    );
    expect(line).toBe('waiting on WhizHQ (crawl running, 42 pages, client info pending, brand voice pending) - poll 7/32');
  });
});

describe('clientTypeFor', () => {
  // clients/onboard is not idempotent, so rehearsing the hand-off against the
  // real API must not leave permanent clients behind.
  it('marks the test bundle\'s clients temporary and everything else standard', () => {
    expect(clientTypeFor('whizhq_only')).toBe('temporary');
    expect(clientTypeFor('full_onboarding')).toBe('standard');
    expect(clientTypeFor(null)).toBe('standard');
    expect(clientTypeFor(undefined)).toBe('standard');
  });
});
