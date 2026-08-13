/**
 * MMW program (agreement type) definitions.
 *
 * The Sales Intake form's "MMW Package" answer is free text typed/selected by a
 * rep ("Practice Pro Program", "The Whiz Works", "smart start"), so everything
 * downstream matches on a normalized key rather than the raw string.
 *
 * `deliverables` is the per-program scope of services, expressed as the ClickUp
 * *Master Account Tracker* custom-field names and the exact dropdown option
 * labels those fields offer. clickup.master_tracker resolves the names against
 * the live field definitions, so renaming an option in ClickUp shows up as a
 * warn in the run log instead of writing a stale UUID.
 *
 * Source of truth: the 2026 program agreements in Drive
 * (Smart_Start_Agreement / Practice_Pro_Agreement / Whiz_Works_Agreement,
 * Exhibit A "Scope of Services"). Keep this table in sync when a program's
 * scope changes; it is deliberately data, not logic.
 */

export type PackageKey = 'smart_start' | 'practice_pro' | 'whiz_works';

export interface PackageDefinition {
  key: PackageKey;
  /** Human label, and the "Contract Type" dropdown option in the tracker. */
  contractType: string;
  /** Standard monthly investment, used only when intake carries no invoice amount. */
  monthlyPrice: number;
  /** Tracker custom field name -> dropdown option label. */
  deliverables: Record<string, string>;
  /** Scope notes that no tracker field can express (cadences, counts). */
  scopeNotes: string[];
}

/**
 * Deliverables shared by all three programs (Exhibit A of each agreement):
 * SEO/AEO, 2+ blogs a month, GBP optimization + posts, 40+ directory listings,
 * WordPress hosting, and the ClinicWhiz (GHL) CRM with review automation.
 */
const COMMON: Record<string, string> = {
  'SEO Services': 'Yes',
  Blogs: 'Yes',
  'GBP Optimization': 'Yes',
  'GBP Posting': 'Yes',
  Citations: 'Yes',
  'MMW Hosting': 'Yes',
  'GHL Subaccount': 'Yes',
  'Reputation Management': 'Yes',
  'Lead Gen Ads Management': 'Yes',
  // Organic social is the client's own job on every program - MMW never posts
  // for them, it only supplies the Dr. Social Whiz platform where included.
  'DFY Social Media': 'No',
  'Video Services': 'No',
};

export const PACKAGES: Record<PackageKey, PackageDefinition> = {
  smart_start: {
    key: 'smart_start',
    contractType: 'Smart Start',
    monthlyPrice: 2497,
    deliverables: {
      ...COMMON,
      'Press Releases': '1 Annually',
      // Smart Start is for practices that run their own email, social, and events.
      'E-Mail Marketing': 'No',
      'Dr. Social Whiz Access': 'No',
      'Events & Webinars': 'No',
      'Lead Magnet': 'No',
      'Top Doctor Magazine Feature': 'No',
    },
    scopeNotes: [
      'SEO/AEO + 2 blogs per month',
      '1 press release per year',
      'Meta ads - 1 topic',
      'Client runs their own email marketing, social, and events (a-la-carte)',
    ],
  },
  practice_pro: {
    key: 'practice_pro',
    contractType: 'Practice Pro',
    monthlyPrice: 3497,
    deliverables: {
      ...COMMON,
      'Press Releases': '1 Quarterly',
      'E-Mail Marketing': 'Yes',
      'E-Mail Marketing Platorm': 'GHL', // field name is misspelled in ClickUp
      'Dr. Social Whiz Access': 'Yes',
      // One signature screening event a year; the dropdown has no "1 Annually"
      // option, so the cadence lives in the Notes field instead.
      'Events & Webinars': 'Yes',
      'Lead Magnet': 'Yes',
      'Top Doctor Magazine Feature': 'No',
    },
    scopeNotes: [
      'SEO/AEO + 2 blogs per month',
      '1 press release per quarter (4/year)',
      'Ads - 1 platform, up to 2 topics',
      '1 signature screening event or webinar per year',
      'Graphic design - 2 projects per year',
      'Healthcare Impact Award + award nomination submissions',
    ],
  },
  whiz_works: {
    key: 'whiz_works',
    contractType: 'Whiz Works',
    monthlyPrice: 5497,
    deliverables: {
      ...COMMON,
      'Press Releases': '1 Monthly',
      'E-Mail Marketing': 'Yes',
      'E-Mail Marketing Platorm': 'GHL',
      'Dr. Social Whiz Access': 'Yes',
      'Events & Webinars': '1 Per Quarter',
      'Lead Magnet': 'Yes',
      'Top Doctor Magazine Feature': 'Yes',
    },
    scopeNotes: [
      'SEO/AEO + 3 blogs per month',
      '1 press release per month (12/year)',
      'Ads - both platforms, up to 2 topics each',
      '4 events or webinars per year (1 per quarter)',
      'Graphic design - 4 projects per year',
      'Monthly executive dashboard',
      'Top Doctor Magazine interview + feature, award nominations',
    ],
  },
};

/** Ordered so a longer/more specific name is tested before a looser one. */
const PATTERNS: [RegExp, PackageKey][] = [
  [/whiz\s*works/i, 'whiz_works'],
  [/practice\s*pro/i, 'practice_pro'],
  [/smart\s*start/i, 'smart_start'],
];

/** Normalize a free-text package answer to a program key (null if none match). */
export function packageKeyOf(raw: string | null | undefined): PackageKey | null {
  if (!raw) return null;
  return PATTERNS.find(([re]) => re.test(raw))?.[1] ?? null;
}

/** The program definition for a free-text package answer, or null. */
export function packageOf(raw: string | null | undefined): PackageDefinition | null {
  const key = packageKeyOf(raw);
  return key ? PACKAGES[key] : null;
}

export function isPracticePro(raw: string | null | undefined): boolean {
  return packageKeyOf(raw) === 'practice_pro';
}
