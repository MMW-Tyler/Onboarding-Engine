import { describe, it, expect } from 'vitest';
import { toHost, looksLikeDomain } from './domain.js';

describe('toHost - tolerant of messy form input', () => {
  it('strips scheme, www, path, query, casing, and whitespace', () => {
    expect(toHost('https://www.Foo.com/contact?x=1')).toBe('foo.com');
    expect(toHost('  WWW.Foo.Com ')).toBe('foo.com');
    expect(toHost('http://foo.com')).toBe('foo.com');
    expect(toHost('foo.com')).toBe('foo.com');
    expect(toHost('foo.com/')).toBe('foo.com');
    expect(toHost('sub.foo.co.uk/page#frag')).toBe('sub.foo.co.uk');
  });
});

describe('looksLikeDomain - rejects junk', () => {
  it('accepts real domains', () => {
    expect(looksLikeDomain('foo.com')).toBe(true);
    expect(looksLikeDomain('https://www.foo.com')).toBe(true);
    expect(looksLikeDomain('sub.foo.co.uk')).toBe(true);
  });
  it('rejects non-domains clients might type', () => {
    expect(looksLikeDomain('n/a')).toBe(false);
    expect(looksLikeDomain('none')).toBe(false);
    expect(looksLikeDomain('coming soon')).toBe(false);
    expect(looksLikeDomain('')).toBe(false);
  });
});
