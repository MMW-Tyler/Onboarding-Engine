import { describe, it, expect } from 'vitest';
import { domainFrom, companyLookups, customerStageFor, lifecycleSummary } from './hubspot.js';

describe('hubspot lifecycle stage', () => {
  it('moves blank and pre-customer stages to customer', () => {
    for (const s of [null, undefined, '', 'subscriber', 'lead', 'marketingqualifiedlead', 'salesqualifiedlead', 'opportunity', 'Lead']) {
      expect(customerStageFor(s)).toBe('customer');
    }
  });

  it('never moves a stage backward or touches a custom one', () => {
    for (const s of ['customer', 'evangelist', 'other', '123456789']) expect(customerStageFor(s)).toBeNull();
  });

  it('says what happened in the roll-up', () => {
    expect(lifecycleSummary({ company: 'set', contactsSet: 1, contactsKept: [] })).toBe('company and 1 contact set to Customer');
    expect(lifecycleSummary({ company: 'set', contactsSet: 2, contactsKept: [] })).toBe('company and 2 contacts set to Customer');
    expect(lifecycleSummary({ company: 'customer', contactsSet: 0, contactsKept: ['customer'] })).toBe('already Customer');
    expect(lifecycleSummary({ company: 'evangelist', contactsSet: 1, contactsKept: [] })).toBe('1 contact set to Customer, company left at evangelist');
    expect(lifecycleSummary({ company: 'set', contactsSet: 0, contactsKept: ['other'] })).toBe('company set to Customer, 1 contact left at other');
    expect(lifecycleSummary(undefined)).toBe('');
  });
});

describe('hubspot company dedup', () => {
  it('drops www so the domain matches how HubSpot stores it', () => {
    expect(domainFrom('https://www.example-clinic.com/')).toBe('example-clinic.com');
    expect(domainFrom('www.Example-Clinic.com')).toBe('example-clinic.com');
    expect(domainFrom('example-clinic.com')).toBe('example-clinic.com');
    expect(domainFrom(undefined)).toBe('');
  });

  it('tries the bare domain, the www domain, the name, then the name without "(Dr. ...)"', () => {
    // An intake that duplicated an existing company record (2026-07).
    expect(companyLookups('Example Clinic (Dr. Jane Doe)', 'www.example-clinic.com')).toEqual([
      ['domain', 'example-clinic.com'],
      ['domain', 'www.example-clinic.com'],
      ['name', 'Example Clinic (Dr. Jane Doe)'],
      ['name', 'Example Clinic'],
    ]);
  });

  it('skips empty and repeated lookups', () => {
    expect(companyLookups('Example Dental', '')).toEqual([['name', 'Example Dental']]);
  });
});
