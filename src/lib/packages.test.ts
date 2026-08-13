import { describe, it, expect } from 'vitest';
import { packageKeyOf, packageOf, isPracticePro, PACKAGES } from './packages.js';

describe('packageKeyOf - matches the free-text package answers reps type', () => {
  it('reads the real intake values', () => {
    expect(packageKeyOf('Practice Pro Program')).toBe('practice_pro');
    expect(packageKeyOf('The Whiz Works Program')).toBe('whiz_works');
    expect(packageKeyOf('Smart Start')).toBe('smart_start');
  });
  it('is tolerant of casing and spacing', () => {
    expect(packageKeyOf('practicepro')).toBe('practice_pro');
    expect(packageKeyOf('  WHIZ  WORKS ')).toBe('whiz_works');
  });
  it('returns null for packages that are not one of the three programs', () => {
    expect(packageKeyOf('Website build only')).toBeNull();
    expect(packageKeyOf('')).toBeNull();
    expect(packageKeyOf(null)).toBeNull();
  });
});

describe('isPracticePro - gates the onboarding-list duplication', () => {
  it('is true only for Practice Pro', () => {
    expect(isPracticePro('Practice Pro Program')).toBe(true);
    expect(isPracticePro('Smart Start')).toBe(false);
    expect(isPracticePro('The Whiz Works Program')).toBe(false);
    expect(isPracticePro(undefined)).toBe(false);
  });
});

describe('deliverables match the 2026 agreements', () => {
  it('scales press releases with the program', () => {
    expect(PACKAGES.smart_start.deliverables['Press Releases']).toBe('1 Annually');
    expect(PACKAGES.practice_pro.deliverables['Press Releases']).toBe('1 Quarterly');
    expect(PACKAGES.whiz_works.deliverables['Press Releases']).toBe('1 Monthly');
  });
  it('gives email marketing + Dr. Social Whiz to Practice Pro and up, not Smart Start', () => {
    expect(PACKAGES.smart_start.deliverables['E-Mail Marketing']).toBe('No');
    expect(PACKAGES.smart_start.deliverables['Dr. Social Whiz Access']).toBe('No');
    for (const key of ['practice_pro', 'whiz_works'] as const) {
      expect(PACKAGES[key].deliverables['E-Mail Marketing']).toBe('Yes');
      expect(PACKAGES[key].deliverables['E-Mail Marketing Platorm']).toBe('GHL');
      expect(PACKAGES[key].deliverables['Dr. Social Whiz Access']).toBe('Yes');
    }
  });
  it('reserves the Top Doctor Magazine feature for Whiz Works', () => {
    expect(PACKAGES.smart_start.deliverables['Top Doctor Magazine Feature']).toBe('No');
    expect(PACKAGES.practice_pro.deliverables['Top Doctor Magazine Feature']).toBe('No');
    expect(PACKAGES.whiz_works.deliverables['Top Doctor Magazine Feature']).toBe('Yes');
  });
  it('includes SEO, GBP, citations, hosting and the GHL sub-account everywhere', () => {
    for (const pkg of Object.values(PACKAGES)) {
      expect(pkg.deliverables['SEO Services']).toBe('Yes');
      expect(pkg.deliverables['GBP Optimization']).toBe('Yes');
      expect(pkg.deliverables['GBP Posting']).toBe('Yes');
      expect(pkg.deliverables.Citations).toBe('Yes');
      expect(pkg.deliverables['MMW Hosting']).toBe('Yes');
      expect(pkg.deliverables['GHL Subaccount']).toBe('Yes');
      expect(pkg.deliverables['DFY Social Media']).toBe('No');
    }
  });
  it('names the ClickUp Contract Type option exactly', () => {
    expect(packageOf('practice pro')?.contractType).toBe('Practice Pro');
    expect(packageOf('smart start')?.contractType).toBe('Smart Start');
    expect(packageOf('whiz works')?.contractType).toBe('Whiz Works');
  });
});
