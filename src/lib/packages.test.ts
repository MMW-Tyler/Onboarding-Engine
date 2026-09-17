import { describe, it, expect } from 'vitest';
import { packageKeyOf, packageOf, isOnboardingPackage, PACKAGES } from './packages.js';

describe('packageKeyOf - matches the free-text package answers reps type', () => {
  it('reads the real intake values', () => {
    expect(packageKeyOf('Practice Pro Program')).toBe('practice_pro');
    expect(packageKeyOf('The Whiz Works Program')).toBe('whiz_works');
    expect(packageKeyOf('Smart Start')).toBe('smart_start');
    expect(packageKeyOf('The Whiz Launch Program')).toBe('whiz_launch');
  });
  it('keeps Whiz Launch and Whiz Works apart', () => {
    expect(packageKeyOf('Whiz Launch')).toBe('whiz_launch');
    expect(packageKeyOf('Whiz Works')).toBe('whiz_works');
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

describe('isOnboardingPackage - gates the intake webhook', () => {
  it('accepts every known program', () => {
    expect(isOnboardingPackage('Practice Pro Program')).toBe(true);
    expect(isOnboardingPackage('Smart Start')).toBe(true);
    expect(isOnboardingPackage('The Whiz Works Program')).toBe(true);
    expect(isOnboardingPackage('The Whiz Launch Program')).toBe(true);
  });
  it('rejects anything else', () => {
    expect(isOnboardingPackage('Website build only')).toBe(false);
    expect(isOnboardingPackage(undefined)).toBe(false);
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
  it('includes SEO, GBP and the GHL sub-account everywhere', () => {
    for (const pkg of Object.values(PACKAGES)) {
      expect(pkg.deliverables['SEO Services']).toBe('Yes');
      expect(pkg.deliverables['GBP Optimization']).toBe('Yes');
      expect(pkg.deliverables['GBP Posting']).toBe('Yes');
      expect(pkg.deliverables['GHL Subaccount']).toBe('Yes');
      expect(pkg.deliverables['DFY Social Media']).toBe('No');
    }
  });
  it('gives hosting and ongoing citations to the retainers only', () => {
    for (const key of ['smart_start', 'practice_pro', 'whiz_works'] as const) {
      expect(PACKAGES[key].deliverables['MMW Hosting']).toBe('Yes');
      expect(PACKAGES[key].deliverables.Citations).toBe('Yes');
    }
    // Whiz Launch clients keep their own website, and their listings push is a
    // one-time 20+ rather than the retainers' ongoing 40+.
    expect(PACKAGES.whiz_launch.deliverables['MMW Hosting']).toBe('No');
    expect(PACKAGES.whiz_launch.deliverables.Citations).toBe('Custom (See Notes)');
  });
  it('names the ClickUp Contract Type option exactly', () => {
    expect(packageOf('practice pro')?.contractType).toBe('Practice Pro');
    expect(packageOf('smart start')?.contractType).toBe('Smart Start');
    expect(packageOf('whiz works')?.contractType).toBe('Whiz Works');
    expect(packageOf('whiz launch')?.contractType).toBe('Whiz Launch');
  });
});

describe('billing shape', () => {
  it('bills the three retainers monthly for a year', () => {
    for (const key of ['smart_start', 'practice_pro', 'whiz_works'] as const) {
      expect(PACKAGES[key].billing).toBe('monthly');
      expect(PACKAGES[key].termMonths).toBe(12);
    }
  });
  it('bills Whiz Launch as one fixed $5,000 fee over 3 months', () => {
    expect(PACKAGES.whiz_launch.billing).toBe('fixed');
    expect(PACKAGES.whiz_launch.price).toBe(5000);
    expect(PACKAGES.whiz_launch.termMonths).toBe(3);
  });
  it('gives Whiz Launch one press release and one event for the whole program', () => {
    expect(PACKAGES.whiz_launch.deliverables['Press Releases']).toBe('1 Lifetime');
    expect(PACKAGES.whiz_launch.deliverables['Events & Webinars']).toBe('1 Lifetime');
  });
  it('keeps email on for Whiz Launch - the managed event sends through GHL either way', () => {
    expect(PACKAGES.whiz_launch.deliverables['E-Mail Marketing']).toBe('Yes');
    expect(PACKAGES.whiz_launch.deliverables['E-Mail Marketing Platorm']).toBe('GHL');
  });
});
