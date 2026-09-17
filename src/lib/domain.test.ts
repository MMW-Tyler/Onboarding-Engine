import { describe, it, expect } from 'vitest';
import { toHost, looksLikeDomain, firstDomainToken, extractWebsiteDomain, websiteHostFrom, emailFrom } from './domain.js';

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

describe('websiteHostFrom - an email in the website field', () => {
  it('passes a normal answer straight through', () => {
    expect(websiteHostFrom('https://www.bodysolutionsmn.com/')).toEqual({ host: 'bodysolutionsmn.com', reason: null });
    expect(websiteHostFrom('bodysolutionsmn.com')).toEqual({ host: 'bodysolutionsmn.com', reason: null });
  });
  it('recovers the practice domain from a work email address', () => {
    expect(websiteHostFrom('info@bodysolutionsmn.com')).toEqual({ host: 'bodysolutionsmn.com', reason: 'email_domain' });
    expect(websiteHostFrom('mailto:Dr.Jane@BodySolutionsMN.com')).toEqual({ host: 'bodysolutionsmn.com', reason: 'email_domain' });
  });
  it('refuses a personal mailbox instead of inventing a domain from it', () => {
    expect(websiteHostFrom('bodysolutionsmn@gmail.com')).toEqual({ host: null, reason: 'free_email' });
    expect(websiteHostFrom('drjane@yahoo.com')).toEqual({ host: null, reason: 'free_email' });
    expect(websiteHostFrom('gmail.com')).toEqual({ host: null, reason: 'free_email' });
  });
  it('prefers a real site typed alongside an email', () => {
    expect(websiteHostFrom('bodysolutionsmn.com (email: drjane@gmail.com)')).toEqual({
      host: 'bodysolutionsmn.com',
      reason: 'email_stripped',
    });
  });
  it('reports answers with nothing usable in them', () => {
    expect(websiteHostFrom('coming soon')).toEqual({ host: null, reason: 'not_a_domain' });
    expect(websiteHostFrom('')).toEqual({ host: null, reason: 'not_a_domain' });
    expect(websiteHostFrom(null)).toEqual({ host: null, reason: 'not_a_domain' });
  });
});

describe('extractWebsiteDomain - webhook run-matching', () => {
  it('still matches a run when the website answer is a work email', () => {
    const body = { 'What is your website URL?': 'frontdesk@bodysolutionsmn.com' };
    expect(extractWebsiteDomain(body)).toBe('bodysolutionsmn.com');
  });
  it('does not match on a personal email address', () => {
    const body = { 'What is your website URL?': 'bodysolutionsmn@gmail.com' };
    expect(extractWebsiteDomain(body)).toBeNull();
  });

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

describe('emailFrom - one field, more than one address', () => {
  it('handles the real answer that stalled the Alevra run', () => {
    // Literal intake value. HubSpot 400'd on the whole string (INVALID_EMAIL)
    // and GHL 422'd ("prospectInfo.email must be an email"), flagging both
    // steps and blocking phase0.gate.
    const v = emailFrom('john@alevra.com  and tanvir@alevra.com');
    expect(v.email).toBe('john@alevra.com');
    expect(v.all).toEqual(['john@alevra.com', 'tanvir@alevra.com']);
    expect(v.extras).toEqual(['tanvir@alevra.com']);
    expect(v.reason).toBe('multiple');
  });

  it('splits on the separators reps actually type', () => {
    for (const raw of [
      'a@x.com, b@x.com',
      'a@x.com; b@x.com',
      'a@x.com and b@x.com',
      'a@x.com / b@x.com',
      'a@x.com\nb@x.com',
      '  a@x.com  |  b@x.com  ',
    ]) {
      const v = emailFrom(raw);
      expect(v.email).toBe('a@x.com');
      expect(v.all).toEqual(['a@x.com', 'b@x.com']);
    }
  });

  it('leaves a single clean address alone', () => {
    const v = emailFrom('barriesteinberg@gmail.com');
    expect(v.email).toBe('barriesteinberg@gmail.com');
    expect(v.extras).toEqual([]);
    expect(v.reason).toBeNull();
  });

  it('strips whitespace, casing, mailto: and surrounding commentary', () => {
    expect(emailFrom('  Dr.Jane@Practice.COM ').email).toBe('dr.jane@practice.com');
    expect(emailFrom('mailto:jane@practice.com').email).toBe('jane@practice.com');
    expect(emailFrom('best is jane@practice.com (checks it daily)').email).toBe('jane@practice.com');
    // Case and surrounding whitespace alone are not worth flagging to a human:
    // the answer WAS a single bare address, just untidily typed.
    expect(emailFrom('  Dr.Jane@Practice.COM ').reason).toBeNull();
    // Real surrounding text is worth flagging.
    expect(emailFrom('best is jane@practice.com (checks it daily)').reason).toBe('trimmed');
  });

  it('does not treat a trailing sentence period as part of the domain', () => {
    expect(emailFrom('email her at jane@practice.com.').email).toBe('jane@practice.com');
  });

  it('collapses duplicates rather than reporting a phantom second contact', () => {
    const v = emailFrom('jane@practice.com, Jane@Practice.com');
    expect(v.all).toEqual(['jane@practice.com']);
    expect(v.extras).toEqual([]);
    expect(v.reason).toBe('trimmed');
  });

  it('keeps consumer mailbox addresses - unlike the website resolver', () => {
    // A gmail address is a fine contact address; it is only useless as a
    // *website* answer (see websiteHostFrom's free_email reason).
    expect(emailFrom('drjane@gmail.com').email).toBe('drjane@gmail.com');
    expect(websiteHostFrom('drjane@gmail.com').host).toBeNull();
  });

  it('reports no_email rather than guessing', () => {
    for (const raw of ['n/a', 'will provide later', 'ask the front desk', '', null, undefined]) {
      const v = emailFrom(raw);
      expect(v.email).toBeNull();
      expect(v.reason).toBe('no_email');
    }
  });
});
