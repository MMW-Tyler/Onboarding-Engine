import { describe, it, expect } from 'vitest';
import { siteCandidates, failureReason } from './site.js';

describe('siteCandidates - the host variants a real practice site might answer on', () => {
  it('tries https apex, https www, then http for a bare host', () => {
    expect(siteCandidates('bodysolutionsmn.com')).toEqual([
      'https://bodysolutionsmn.com',
      'https://www.bodysolutionsmn.com',
      'http://bodysolutionsmn.com',
      'http://www.bodysolutionsmn.com',
    ]);
  });
  it('keeps the form the client gave us first when they typed www', () => {
    expect(siteCandidates('www.bodysolutionsmn.com')[0]).toBe('https://www.bodysolutionsmn.com');
    expect(siteCandidates('www.bodysolutionsmn.com')[1]).toBe('https://bodysolutionsmn.com');
  });
  it('tolerates a scheme or path being passed in', () => {
    expect(siteCandidates('https://bodysolutionsmn.com/contact')[0]).toBe('https://bodysolutionsmn.com');
  });
  it('returns nothing for a value that is not a host', () => {
    expect(siteCandidates('coming soon')).toEqual([]);
    expect(siteCandidates('')).toEqual([]);
  });
});

describe('failureReason - says which kind of unreachable', () => {
  it('names DNS, TLS, refusal and timeout failures from the nested cause', () => {
    expect(failureReason(Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } }))).toBe('dns_error');
    expect(failureReason(Object.assign(new Error('fetch failed'), { cause: { code: 'ERR_TLS_CERT_ALTNAME_INVALID' } }))).toBe('tls_error');
    expect(failureReason(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))).toBe('connection_refused');
    expect(failureReason(Object.assign(new Error('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }))).toBe('timeout');
  });
  it('reports an aborted request as a timeout', () => {
    const err = new Error('This operation was aborted');
    err.name = 'AbortError';
    expect(failureReason(err)).toBe('timeout');
  });
  it('falls back to a generic reason for anything unrecognised', () => {
    expect(failureReason(new Error('boom'))).toBe('fetch_error');
  });
});
