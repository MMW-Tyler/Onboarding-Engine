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
 * (Smart_Start_Agreement / Practice_Pro_Agreement / Whiz_Works_Agreement /
 * Whiz_Launch_Program_Agreement, Exhibit A "Scope of Services"). Keep this
 * table in sync when a program's scope changes; it is deliberately data, not
 * logic.
 */

export type PackageKey = 'smart_start' | 'practice_pro' | 'whiz_works' | 'whiz_launch';

export interface PackageDefinition {
  key: PackageKey;
  /** Human label, and the "Contract Type" dropdown option in the tracker. */
  contractType: string;
  /**
   * How the program is billed:
   *  - 'monthly': an ongoing retainer. `price` is the monthly investment and the
   *    tracker's Monthly Committment field gets it (or the intake's invoice
   *    amount, which wins).
   *  - 'fixed': a one-time program fee covering the whole term. `price` is that
   *    TOTAL, and Monthly Committment is deliberately left blank - writing a
   *    program total into a monthly field overstates MRR by the term length.
   *    The total goes in the tracker's Notes instead.
   */
  billing: 'monthly' | 'fixed';
  /** Monthly investment ('monthly') or the whole program fee ('fixed'), in dollars. */
  price: number;
  /**
   * Contract length in months. On a 'monthly' program this is only the fallback
   * for an intake that gives no parseable length; on a 'fixed' program the term
   * is set by the agreement, so this wins over whatever the intake says.
   */
  termMonths: number;
  /** Tracker custom field name -> dropdown option label. */
  deliverables: Record<string, string>;
  /** Scope notes that no tracker field can express (cadences, counts). */
  scopeNotes: string[];
}

/**
 * Deliverables shared by the three ongoing retainers (Exhibit A of each
 * agreement): SEO/AEO, 2+ blogs a month, GBP optimization + posts, 40+
 * directory listings, WordPress hosting, and the ClinicWhiz (GHL) CRM with
 * review automation.
 *
 * Whiz Launch spreads this too but overrides the pieces a 3-month launch sprint
 * does differently (fixed blog/listing counts) or does not include at all
 * (hosting - those clients keep their own website).
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
    billing: 'monthly',
    price: 2497,
    termMonths: 12,
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
    billing: 'monthly',
    price: 3497,
    termMonths: 12,
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
  /**
   * The 3-month new-practice launch sprint (2026 Whiz Launch Program Agreement).
   * Everything here is delivered ONCE inside the Program Term rather than on a
   * monthly rotation, which is why several fields read "Custom (See Notes)"
   * where a retainer would read "Yes": the tracker's dropdowns describe an
   * ongoing cadence and this program has none.
   *
   * The two structural differences from Practice Pro, whose scope it otherwise
   * tracks closely: the client keeps their own website (no build, no MMW
   * hosting), and the whole engagement is a fixed $5,000 rather than a retainer.
   */
  whiz_launch: {
    key: 'whiz_launch',
    contractType: 'Whiz Launch',
    billing: 'fixed',
    price: 5000,
    termMonths: 3,
    deliverables: {
      ...COMMON,
      // Fixed counts for the whole program, not a monthly cadence - the exact
      // numbers live in scopeNotes and land in the tracker's Notes field.
      Blogs: 'Custom (See Notes)',
      Citations: 'Custom (See Notes)',
      // No website build and no hosting: Whiz Launch is sold to practices that
      // already have a site. This is the one deliverable the retainers all have
      // and this program does not.
      'MMW Hosting': 'No',
      'Press Releases': '1 Lifetime',
      // Email is NOT conditional on the client's choose-one: the managed event
      // runs its invites, RSVP confirmations, reminders and follow-up sequence
      // through GHL regardless. The choose-one only decides whether they also
      // get a recurring newsletter (see scopeNotes).
      'E-Mail Marketing': 'Yes',
      'E-Mail Marketing Platorm': 'GHL',
      'Dr. Social Whiz Access': 'Yes',
      'Events & Webinars': '1 Lifetime',
      'Lead Magnet': 'No',
      'Top Doctor Magazine Feature': 'No',
    },
    scopeNotes: [
      '3-month launch sprint delivered once, NOT a monthly rotation',
      '30-page marketing analysis report + 1:1 Zoom strategy session',
      '3 blogs for the program (not per month)',
      '1 press release, distributed for media pickup',
      '20+ directory listings (one-time push, not the retainers\' 40+ ongoing)',
      'GBP optimization + posts, 5-star Google review campaigns',
      'Dr. Social Whiz scheduler access + Meta ad management',
      'Client picks ONE: monthly email newsletter OR a dedicated Meta ad campaign - confirm at the strategy session and record it here',
      '1 event or webinar, fully managed (Eventbrite, invite funnel, social, email, SMS, RSVP, post-event follow-up). Client owes 6-8 weeks notice, so book the date early',
      'Client keeps their own website - MMW does not build or host it',
      '3 hrs/month of professional services included, $300/hr beyond that (written approval required first)',
      'Wrap-up: performance report, before/after snapshot, final results meeting',
      'Day 45: second $2,500 payment. Day 60: MMW contacts the client to review results and discuss converting to a retainer (converting waives the retainer onboarding fee)',
    ],
  },
  whiz_works: {
    key: 'whiz_works',
    contractType: 'Whiz Works',
    billing: 'monthly',
    price: 5497,
    termMonths: 12,
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
  // 'whiz launch' before 'whiz works' - they do not overlap, but keeping the
  // more specific brand names together and first keeps this honest if one of
  // them ever gains a longer variant.
  [/whiz\s*launch/i, 'whiz_launch'],
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

/**
 * Whether a package answer is one the engine runs full onboarding for. The
 * intake webhook gates on this, so adding a program to PACKAGES is all it takes
 * for its forms to start creating runs.
 */
export function isOnboardingPackage(raw: string | null | undefined): boolean {
  return packageKeyOf(raw) !== null;
}
