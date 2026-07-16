import { normalizeFields, type FieldMapping } from '../lib/anthropic.js';
import { SENSITIVE_KEYS } from '../redact.js';

/**
 * Canonical field schema + deterministic mapping (spec section 11 + Prompts 1-2).
 * Deterministic substring/regex rules run first; only labels that don't match
 * fall through to the Anthropic API. Values are always copied verbatim.
 *
 * Sensitive keys (npi, dea, state_license, domain_credentials,
 * website_credentials) are routed to a separate bucket and never placed in the
 * open profile (the caller writes them to restricted storage / Drive folder 12).
 */
export interface CanonicalKey {
  key: string;
  description: string;
  sensitive?: boolean;
}

export interface NormalizeResult {
  /** non-sensitive canonical fields, values verbatim */
  profile: Record<string, string>;
  /** sensitive fields, routed separately, never logged in the open */
  sensitive: Record<string, string>;
  /** labels the model mapped with low confidence or to UNMAPPED, for human review */
  unmapped: { raw_label: string; raw_value: string; reason: string }[];
}

/**
 * Values that mean "no real answer given" rather than an actual answer -
 * clients type these into free-text questions constantly (confirmed against
 * live form data: "N/A", "na", "IDK", "?", "not sure", "will provide later").
 * Deliberately narrow: it never matches "no"/"none", which are legitimate
 * substantive answers to this form's yes/no questions (do you have other
 * locations, are you in a chamber of commerce, etc).
 */
export const NON_ANSWER = /^(n\/?a\.?|idk|i\s*don'?t\s*know(\s*yet)?|unsure|not\s*sure(\s*yet)?|tbd|to\s*be\s*determined|\?+|will\s*provide\s*later|changing)$/i;

// --- Sales Intake Form (Wave 1) ---------------------------------------------
// Canonical keys derived from the live Sales Intake Form fields.
export const INTAKE_KEYS: CanonicalKey[] = [
  { key: 'office_name', description: 'Practice / office name (also used as client_name)' },
  { key: 'website_url', description: "Practice website URL" },
  { key: 'doctor_first_name', description: 'Primary doctor first name' },
  { key: 'doctor_last_name', description: 'Primary doctor last name' },
  { key: 'office_manager_name', description: 'Office manager full name' },
  { key: 'doctor_email', description: "Doctor's email address" },
  { key: 'office_manager_email', description: "Office manager's email address" },
  { key: 'nap_street', description: 'Street address (NAP)' },
  { key: 'nap_city', description: 'City (NAP)' },
  { key: 'nap_state', description: 'State (NAP)' },
  { key: 'nap_zip', description: 'ZIP / postal code (NAP)' },
  { key: 'nap_phone', description: 'Office phone number (NAP)' },
  { key: 'doctor_mobile', description: "Doctor's mobile phone number" },
  { key: 'package', description: 'MMW package purchased' },
  { key: 'special_additions', description: 'Special additions or things promised' },
  { key: 'contract_length', description: 'Length of contract' },
  { key: 'start_date', description: 'Engagement start date' },
  { key: 'book_to_mail', description: 'Book to mail flag/notes' },
  { key: 'client_specialty', description: 'Practice specialty (e.g. dental, derm, med-spa)' },
  { key: 'invoice_amount', description: 'Invoice amount' },
  { key: 'website_build_notes', description: 'Website build notes' },
  { key: 'website_build_type', description: 'Website build type' },
  { key: 'submitted_at', description: 'Form submission timestamp' },
];

// Ordered deterministic rules. First match wins, so more-specific patterns lead.
const INTAKE_RULES: [RegExp, string][] = [
  [/timestamp/, 'submitted_at'],
  [/website build type/, 'website_build_type'],
  [/website build/, 'website_build_notes'],
  [/website|url/, 'website_url'],
  [/office manager email|manager email/, 'office_manager_email'],
  [/name of office manager|office manager/, 'office_manager_name'],
  [/email address of doctor|doctor email|email/, 'doctor_email'],
  [/first name/, 'doctor_first_name'],
  [/last name/, 'doctor_last_name'],
  [/name of office|office name/, 'office_name'],
  [/mobile/, 'doctor_mobile'],
  [/office phone|phone number|phone/, 'nap_phone'],
  [/street address|street|address/, 'nap_street'],
  [/mmw package|package/, 'package'],
  [/special additions|things promised|special/, 'special_additions'],
  [/length of contract|contract/, 'contract_length'],
  [/start date/, 'start_date'],
  [/zip|postal/, 'nap_zip'],
  [/city/, 'nap_city'],
  [/state/, 'nap_state'],
  [/book to mail/, 'book_to_mail'],
  [/client specialty|specialty/, 'client_specialty'],
  [/invoice/, 'invoice_amount'],
];

// --- Client MMW Form (Wave 2) -----------------------------------------------
// Canonical keys derived from the live Client MMW onboarding form fields.
// Sensitive keys route to restricted storage (Drive folder 12), never the open profile.
export const CLIENTFORM_KEYS: CanonicalKey[] = [
  { key: 'submitted_at', description: 'Form submission timestamp' },
  { key: 'contact_email', description: 'Submitter email address' },
  { key: 'website_url', description: 'Practice website URL' },
  { key: 'facebook_url', description: 'Facebook page URL' },
  { key: 'instagram_url', description: 'Instagram profile URL' },
  { key: 'youtube_url', description: 'YouTube channel URL' },
  { key: 'linkedin_url', description: 'LinkedIn profile URL' },
  { key: 'usp_reason', description: 'Unique selling point that made them say yes' },
  { key: 'monthly_revenue', description: 'Average monthly revenue' },
  { key: 'goals_12mo', description: '12-month goals and vision' },
  { key: 'focus_services', description: 'Top services to grow' },
  { key: 'ideal_patient', description: 'Ideal patient description + demographics' },
  { key: 'lifetime_patient_value', description: 'Lifetime patient value' },
  { key: 'referral_interest', description: 'Interest in referral program' },
  { key: 'referral_doctors', description: 'Other doctors they can refer/connect' },
  { key: 'agreement_ack', description: 'Program agreement acknowledgement' },
  { key: 'hobbies', description: 'Hobbies and interests' },
  { key: 'lunch_spots', description: 'Favorite local lunch spots' },
  { key: 'email_count', description: 'Size of email list' },
  { key: 'credentials', description: 'Board certifications and awards' },
  { key: 'legal_business_name', description: 'Legal business name' },
  { key: 'differentiators', description: 'What makes the office unique' },
  { key: 'birthdays', description: 'Doctor/provider birthdays' },
  { key: 'contact_phone', description: 'Best phone to reach them directly' },
  { key: 'nap_phone', description: 'Office phone to list on Google (NAP)' },
  { key: 'point_person', description: 'Marketing point person (name + email)' },
  { key: 'nap_address', description: 'Exact office address to list on Google (NAP)' },
  { key: 'nap_email', description: 'Office email to list on Google (NAP)' },
  { key: 'other_locations', description: 'Other office locations + addresses' },
  { key: 'geo_targets', description: 'Additional cities to target' },
  { key: 'insurance_vs_cash', description: 'Insurance vs cash service mix' },
  { key: 'financing_options', description: 'Patient financing options offered' },
  { key: 'year_founded', description: 'Year the practice was founded' },
  { key: 'office_hours', description: 'Office hours to list online' },
  { key: 'chamber_of_commerce', description: 'Chamber of commerce membership(s)' },
  { key: 'licensed_states', description: 'States licensed to practice in' },
  { key: 'years_experience', description: 'Overall years of experience' },
  { key: 'undergrad', description: 'Undergraduate school' },
  { key: 'residency', description: 'Residency location' },
  { key: 'medical_school', description: 'Medical school and graduation year' },
  { key: 'providers', description: 'Provider name(s)' },
  { key: 'community_groups', description: 'Fitness/community/business groups' },
  { key: 'npi', description: 'National Provider Identifier', sensitive: true },
  { key: 'dea', description: 'DEA registration number', sensitive: true },
  { key: 'state_license', description: 'State medical license NUMBER', sensitive: true },
  { key: 'domain_credentials', description: 'Domain registrar login + password', sensitive: true },
  { key: 'website_credentials', description: 'Website/CMS login URL, username, password', sensitive: true },
  { key: 'dns_credentials', description: 'DNS management location + logins', sensitive: true },
];
// Sensitive rules lead so credentials are deterministically routed and never leak.
const CLIENTFORM_RULES: [RegExp, string][] = [
  [/npi/, 'npi'],
  [/\bdea\b|dea number/, 'dea'],
  [/state license number|license number/, 'state_license'],
  [/domain login|domain.*password|where you purchased/, 'domain_credentials'],
  [/website login|login page|wordpress|website platform/, 'website_credentials'],
  [/dns settings|dns/, 'dns_credentials'],
  // general
  [/timestamp/, 'submitted_at'],
  [/facebook/, 'facebook_url'],
  [/instagram/, 'instagram_url'],
  [/youtube/, 'youtube_url'],
  [/linkedin/, 'linkedin_url'],
  [/unique selling point|say yes/, 'usp_reason'],
  [/monthly revenue|average monthly/, 'monthly_revenue'],
  [/12 month|month goal|goal and vision|vision for your practice/, 'goals_12mo'],
  [/top services|services that you want to grow|services.*grow/, 'focus_services'],
  [/ideal patient/, 'ideal_patient'],
  [/lifetime patient value|lifetime value/, 'lifetime_patient_value'],
  [/referral program|marketing program for free/, 'referral_interest'],
  [/speak to any other doctors|connect us via email|other doctors yet/, 'referral_doctors'],
  [/you agree|excited to get started|single point person from your office/, 'agreement_ack'],
  [/hobbies/, 'hobbies'],
  [/lunch spots/, 'lunch_spots'],
  [/how many emails/, 'email_count'],
  [/board certification|awards/, 'credentials'],
  [/legal name/, 'legal_business_name'],
  [/makes your office unique|why should a patient choose/, 'differentiators'],
  [/birthday/, 'birthdays'],
  [/best phone number to reach you/, 'contact_phone'],
  [/office phone number/, 'nap_phone'],
  [/point person/, 'point_person'],
  [/exact office address|office address that you want listed|office address/, 'nap_address'],
  [/office email address/, 'nap_email'],
  [/other locations/, 'other_locations'],
  [/other cities|cities that you want|target in your area|nearby suburbs/, 'geo_targets'],
  [/insurance vs cash|insurance vs/, 'insurance_vs_cash'],
  [/financing|care credit|cherry/, 'financing_options'],
  [/year.*founded|practice founded|year was your practice/, 'year_founded'],
  [/office hours|correct office hours/, 'office_hours'],
  [/chamber of commerce/, 'chamber_of_commerce'],
  [/licensed to practice|state.*licensed/, 'licensed_states'],
  [/years of experience|years.*experience/, 'years_experience'],
  [/undergrad/, 'undergrad'],
  [/residency/, 'residency'],
  [/medical school/, 'medical_school'],
  [/provider name/, 'providers'],
  [/fitness groups|clubs|community|business organizations/, 'community_groups'],
  [/website url|what is your website/, 'website_url'],
  [/email address|email/, 'contact_email'],
];

export const SCHEMAS = {
  intake: { keys: INTAKE_KEYS, rules: INTAKE_RULES },
  clientform: { keys: CLIENTFORM_KEYS, rules: CLIENTFORM_RULES },
} as const;

function normLabel(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function isSensitive(key: string, keys: CanonicalKey[]): boolean {
  if (SENSITIVE_KEYS.has(key)) return true;
  return keys.find((k) => k.key === key)?.sensitive === true;
}

/**
 * Pure deterministic pass (no AI / no network). Routes each raw field to a
 * canonical key via the ordered rule table; unmatched labels go to `toAI`.
 * Sensitive keys are routed to the `sensitive` bucket. Testable in isolation.
 *
 * Two guards beyond plain label->key routing:
 *  - Non-answer scrubbing: a value that's just "n/a"/"idk"/"?" etc. is
 *    dropped rather than stored, and reported in `dropped` for human review.
 *  - First-non-empty-wins: the client form has accumulated duplicate/legacy
 *    question variants over the years (e.g. three office-hours phrasings). If
 *    two raw labels map to the same canonical key, the first real value found
 *    wins; a differing later value is reported in `dropped` rather than
 *    silently overwriting the real answer.
 */
export function mapDeterministic(
  raw: Record<string, unknown>,
  schema: 'intake' | 'clientform',
): {
  profile: Record<string, string>;
  sensitive: Record<string, string>;
  toAI: { raw_label: string; raw_value: string }[];
  dropped: { raw_label: string; raw_value: string; reason: string }[];
} {
  const { keys, rules } = SCHEMAS[schema];
  const profile: Record<string, string> = {};
  const sensitive: Record<string, string> = {};
  const toAI: { raw_label: string; raw_value: string }[] = [];
  const dropped: { raw_label: string; raw_value: string; reason: string }[] = [];

  for (const [label, value] of Object.entries(raw)) {
    if (value == null || value === '') continue;
    const v = String(value);
    const norm = normLabel(label);
    const rule = rules.find(([re]) => re.test(norm));
    if (!rule) {
      toAI.push({ raw_label: label, raw_value: v });
      continue;
    }

    const key = rule[1];
    if (NON_ANSWER.test(v.trim())) {
      dropped.push({ raw_label: label, raw_value: v, reason: `non_answer:${key}` });
      continue;
    }

    const bucket = isSensitive(key, keys) ? sensitive : profile;
    if (bucket[key] !== undefined) {
      if (bucket[key] !== v) {
        dropped.push({ raw_label: label, raw_value: v, reason: `duplicate_of:${key}` });
      }
      continue;
    }
    bucket[key] = v;
  }
  return { profile, sensitive, toAI, dropped };
}

/**
 * Normalize raw {label: value} form data into canonical keys.
 * Deterministic rules first; unmatched labels go to the Anthropic API.
 */
export async function normalizeProfile(
  raw: Record<string, unknown>,
  schema: 'intake' | 'clientform',
  systemText: string,
): Promise<NormalizeResult> {
  const { keys } = SCHEMAS[schema];
  const det = mapDeterministic(raw, schema);
  const profile = det.profile;
  const sensitive = det.sensitive;
  const toAI = det.toAI;
  const unmapped: NormalizeResult['unmapped'] = [...det.dropped];

  // AI fallback for anything deterministic rules missed.
  if (toAI.length > 0) {
    let mappings: FieldMapping[] = [];
    try {
      mappings = await normalizeFields({
        systemText,
        canonicalKeys: keys.map((k) => ({ key: k.key, description: k.description, sensitive: k.sensitive })),
        unmappedFields: toAI,
      });
    } catch {
      // If the AI call fails, leave the fields unmapped for human review.
      for (const f of toAI) unmapped.push({ ...f, reason: 'ai_unavailable' });
      mappings = [];
    }
    const byLabel = new Map(mappings.map((m) => [m.raw_label, m]));
    for (const f of toAI) {
      const m = byLabel.get(f.raw_label);
      if (!m || m.chosen_key === 'UNMAPPED' || m.confidence < 0.6) {
        if (m) unmapped.push({ ...f, reason: m.chosen_key === 'UNMAPPED' ? 'unmapped' : `low_confidence_${m.confidence}` });
        else unmapped.push({ ...f, reason: 'not_returned' });
        continue;
      }
      assign(m.chosen_key, f.raw_value);
    }
  }

  return { profile, sensitive, unmapped };

  function assign(key: string, value: string): void {
    if (isSensitive(key, keys)) sensitive[key] = value;
    else profile[key] = value;
  }
}
