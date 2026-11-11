import { describe, it, expect } from 'vitest';
import { domainFrom, companyLookups } from './hubspot.js';

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
