import { describe, it, expect } from 'vitest';
import { toHost, looksLikeDomain, firstDomainToken, extractWebsiteDomain } from './domain.js';

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

describe('firstDomainToken - pulls a domain out of a messy answer', () => {
  it('finds a domain inside a multi-value or annotated cell', () => {
    expect(firstDomainToken('www.innovativewellnessinc.com [practice]\nwww.fulfillene.com [product]\n')).toBe(
      'innovativewellnessinc.com',
    );
    expect(firstDomainToken('Visit us at foo-bar.com for more info')).toBe('foo-bar.com');
  });
  it('returns null when there is nothing domain-shaped', () => {
    expect(firstDomainToken('Premier Body Sculpting &Esthetics (changing name)')).toBeNull();
    expect(firstDomainToken('I think Vanessa figured this out!')).toBeNull();
  });
});

describe('extractWebsiteDomain - webhook run-matching', () => {
  it('matches the website question, not a social-profile "URL" question', () => {
    const body = {
      'What is your website URL?': 'https://www.smiledental.com',
      "Please list Facebook URL (put n/a if you don't have one)": 'https://www.facebook.com/smiledental',
    };
    expect(extractWebsiteDomain(body)).toBe('smiledental.com');
  });
  it('extracts a domain from a compound multi-site answer', () => {
    const body = { 'What is your website URL?': 'www.innovativewellnessinc.com [practice]\nwww.fulfillene.com [product]\n' };
    expect(extractWebsiteDomain(body)).toBe('innovativewellnessinc.com');
  });
  it('returns null rather than a false match on a non-domain answer', () => {
    const body = { 'What is your website URL?': 'Premier Body Sculpting &Esthetics (changing name)' };
    expect(extractWebsiteDomain(body)).toBeNull();
  });
});
