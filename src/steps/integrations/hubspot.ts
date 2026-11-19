import type { Step, StepContext } from '../../types.js';
import { db } from '../../supabase.js';
import { callApi } from '../../lib/http.js';
import { config } from '../../config.js';
import { profileOf, simId, simulated } from './util.js';

/**
 * HubSpot CRM workers (spec section 08: hubspot.upsert): upsert the client as a
 * Company and create contacts for the doctor and office manager. reversible-write:
 * simulated in dry-run (auth probe only, no writes).
 *
 * Uses HubSpot CRM API v3. 409 already-exists on contact create is tolerated --
 * the contact is already in CRM, which is the desired end state.
 */
const BASE = 'https://api.hubapi.com';

function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${config.hubspot.accessToken()}` };
}

/**
 * Derive a bare hostname from a URL string ("https://www.example-clinic.com/" ->
 * "example-clinic.com"); empty string on parse failure. HubSpot stores company
 * domains without "www.", and an exact search for "www.example-clinic.com" missed
 * the existing "example-clinic.com" company and created a duplicate
 * (2026-07-21).
 */
export function domainFrom(websiteUrl: string | undefined): string {
  if (!websiteUrl) return '';
  try {
    return new URL(websiteUrl.startsWith('http') ? websiteUrl : `https://${websiteUrl}`).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Exact searches to try, in order, before creating a company: the bare domain,
 * its www form (older records), the full name, then the name without a
 * trailing "(Dr. ...)" ("Example Clinic (Dr. Jane Doe)" -> "Example Clinic").
 */
export function companyLookups(name: string, domain: string): [string, string][] {
  const bare = (domain || '').toLowerCase().replace(/^www\./, '');
  const short = (name || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  const all: [string, string][] = [
    ['domain', bare],
    ['domain', bare ? `www.${bare}` : ''],
    ['name', (name || '').trim()],
    ['name', short],
  ];
  const seen = new Set<string>();
  return all.filter(([prop, value]) => {
    const key = `${prop}:${value}`;
    if (!value || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// --- search helpers (dedup): find an existing record before creating one ---

/**
 * Search a HubSpot CRM object by an exact property match; return the first
 * record's id and lifecycle stage, or null when nothing matches.
 */
async function searchFirst(
  ctx: StepContext,
  headers: Record<string, string>,
  object: 'companies' | 'contacts',
  propertyName: string,
  value: string,
): Promise<{ id: string; lifecyclestage: string | null } | null> {
  if (!value) return null;
  const res = await callApi<any>(ctx, `${BASE}/crm/v3/objects/${object}/search`, `hubspot.${object}.search`, {
    method: 'POST',
    headers,
    json: { filterGroups: [{ filters: [{ propertyName, operator: 'EQ', value }] }], properties: [propertyName, 'lifecyclestage'], limit: 1 },
  });
  const hit = res.body?.results?.[0];
  if (!hit?.id) return null;
  return { id: String(hit.id), lifecyclestage: (hit.properties?.lifecyclestage as string | undefined) || null };
}

// --- lifecycle stage: a signed client is a Customer ---

/**
 * HubSpot's standard lifecycle stages that come before "customer". The Sales
 * Intake form is sent after the contract is signed, so the company and its
 * contacts are customers from this run on. That is onboarding step 0.5, which
 * WhizHQ's Onboarding Manager proves from HubSpot and checks off by itself once
 * the company and a contact both say Customer (2026-11-19: a new client sat at
 * "Lead" because nothing set it).
 */
const BEFORE_CUSTOMER = new Set(['subscriber', 'lead', 'marketingqualifiedlead', 'salesqualifiedlead', 'opportunity']);

/**
 * The stage to write for a record that is at `current` now: "customer" when it
 * is blank or an earlier stage, otherwise null (leave it alone). HubSpot only
 * moves a stage forward through the API, and evangelist, other or a custom
 * stage is a choice somebody made.
 */
export function customerStageFor(current: string | null | undefined): 'customer' | null {
  const stage = String(current || '').trim().toLowerCase();
  return !stage || BEFORE_CUSTOMER.has(stage) ? 'customer' : null;
}

export interface LifecycleResult {
  /** "set", or the stage the company was left at ("customer", "evangelist", ...). */
  company?: string;
  contactsSet?: number;
  /** Stages of contacts left as they were (already customer or later). */
  contactsKept?: string[];
}

/** The roll-up's words for what happened to lifecycle stages ("" when nothing to say). */
export function lifecycleSummary(l: LifecycleResult | undefined): string {
  if (!l) return '';
  const n = l.contactsSet || 0;
  const contacts = n ? `${n} contact${n === 1 ? '' : 's'}` : '';
  const parts: string[] = [];
  if (l.company === 'set') parts.push(contacts ? `company and ${contacts} set to Customer` : 'company set to Customer');
  else if (contacts) parts.push(`${contacts} set to Customer`);
  if (l.company && l.company !== 'set' && l.company !== 'customer') parts.push(`company left at ${l.company}`);
  const keptLater = (l.contactsKept || []).filter((s) => s !== 'customer');
  if (keptLater.length) parts.push(`${keptLater.length} contact${keptLater.length === 1 ? '' : 's'} left at ${[...new Set(keptLater)].join(', ')}`);
  if (!parts.length && (l.company === 'customer' || (l.contactsKept || []).length)) parts.push('already Customer');
  return parts.join(', ');
}

/** Associate a contact to a company using the v4 default (primary) association. */
async function associateContactToCompany(
  ctx: StepContext,
  headers: Record<string, string>,
  contactId: string,
  companyId: string,
): Promise<void> {
  // PUT with the "default" label creates HubSpot's standard contact<->company link.
  // 200/201 both mean linked; an existing link is returned idempotently.
  await callApi(
    ctx,
    `${BASE}/crm/v4/objects/contacts/${contactId}/associations/default/companies/${companyId}`,
    'hubspot.associate.contact_company',
    { method: 'PUT', headers, json: {} },
  );
}

// --- upsert (company + contacts) ---

async function upsertReal(ctx: StepContext): Promise<Record<string, unknown>> {
  const p = profileOf(ctx.run);
  const headers = authHeaders();

  const name = p.office_name ?? (ctx.run.client_name as string) ?? '';
  const domain = domainFrom(p.website_url) || (ctx.run.domain as string | undefined) || '';

  // 1. Resolve the company: search by domain first (most reliable), then by name,
  //    so we update the existing record instead of creating a duplicate.
  const companyProperties: Record<string, string> = {
    name,
    domain,
    phone: p.nap_phone ?? '',
    city: p.nap_city ?? '',
    state: p.nap_state ?? '',
  };
  // Drop empty values so we never overwrite existing CRM data with blanks.
  for (const key of Object.keys(companyProperties)) {
    if (!companyProperties[key]) delete companyProperties[key];
  }

  let existingCompany: { id: string; lifecyclestage: string | null } | null = null;
  for (const [prop, value] of companyLookups(name, domain)) {
    existingCompany = await searchFirst(ctx, headers, 'companies', prop, value);
    if (existingCompany) break;
  }
  const existingCompanyId = existingCompany?.id ?? null;
  // Signed client: move the company to Customer (forward only, see customerStageFor).
  const companyStage = customerStageFor(existingCompany?.lifecyclestage);
  if (companyStage) companyProperties.lifecyclestage = companyStage;
  const companyLifecycle = companyStage ? 'set' : String(existingCompany?.lifecyclestage);
  // An existing record keeps its own name and domain (sales' "Example Clinic" must
  // not be renamed "Example Clinic (Dr. Jane Doe)"); phone, city and state still fill in.
  if (existingCompanyId) {
    delete companyProperties.name;
    delete companyProperties.domain;
  }

  let companyId: string;
  let companyExisted: boolean;
  if (existingCompanyId) {
    // Update in place (only non-empty props survived the prune above).
    companyId = existingCompanyId;
    if (Object.keys(companyProperties).length) {
      const upd = await callApi<any>(ctx, `${BASE}/crm/v3/objects/companies/${existingCompanyId}`, 'hubspot.companies.update', {
        method: 'PATCH',
        headers,
        json: { properties: companyProperties },
      });
      companyId = (upd.body?.id as string) ?? existingCompanyId;
    }
    companyExisted = true;
  } else {
    const created = await callApi<any>(ctx, `${BASE}/crm/v3/objects/companies`, 'hubspot.companies.create', {
      method: 'POST',
      headers,
      json: { properties: companyProperties },
    });
    companyId = created.body.id;
    companyExisted = false;
  }

  // Persist the company id to the run so downstream steps can reference it.
  await db()
    .from('onboarding_runs')
    .update({ hubspot_company_id: companyId, updated_at: new Date().toISOString() })
    .eq('id', ctx.run.id);

  // 2. Resolve contacts (doctor + office manager) by email, then EXPLICITLY link
  //    each to the company. Without this, HubSpot's "auto-associate by email
  //    domain" setting attaches the contact to a company built from the email's
  //    domain (e.g. zippymail.info) instead of the real client company.
  const contactsCreated: string[] = [];
  let associated = 0;
  let contactsSet = 0;
  const contactsKept: string[] = [];

  const candidates: Array<{ email: string | undefined; firstName?: string; lastName?: string; fullName?: string }> = [
    { email: p.doctor_email, firstName: p.doctor_first_name, lastName: p.doctor_last_name },
    { email: p.office_manager_email, fullName: p.office_manager_name },
  ];

  for (const candidate of candidates) {
    if (!candidate.email) continue;

    const contactProperties: Record<string, string> = { email: candidate.email };
    if (candidate.firstName) contactProperties.firstname = candidate.firstName;
    if (candidate.lastName) contactProperties.lastname = candidate.lastName;
    if (candidate.fullName && !candidate.firstName) {
      // Split "First Last" on the first space; remainder becomes lastname.
      const [first, ...rest] = candidate.fullName.split(' ');
      if (first) contactProperties.firstname = first;
      if (rest.length) contactProperties.lastname = rest.join(' ');
    }

    // Dedup by email: update the existing contact, or create a new one.
    const existingContact = await searchFirst(ctx, headers, 'contacts', 'email', candidate.email);
    let contactId = existingContact?.id ?? null;
    const contactStage = customerStageFor(existingContact?.lifecyclestage);
    if (contactStage) {
      contactProperties.lifecyclestage = contactStage;
      contactsSet += 1;
    } else if (existingContact?.lifecyclestage) {
      contactsKept.push(existingContact.lifecyclestage);
    }
    if (contactId) {
      await callApi<any>(ctx, `${BASE}/crm/v3/objects/contacts/${contactId}`, 'hubspot.contacts.update', {
        method: 'PATCH',
        headers,
        json: { properties: contactProperties },
      });
    } else {
      // 409 = created between our search and create (race); tolerate it.
      const created = await callApi<any>(ctx, `${BASE}/crm/v3/objects/contacts`, 'hubspot.contacts.create', {
        method: 'POST',
        headers,
        json: { properties: contactProperties },
        okStatuses: [409],
      });
      contactId = (created.body?.id as string | undefined) ?? null;
    }

    contactsCreated.push(candidate.email);

    // Link the contact to the client company (the part that was missing before).
    if (contactId) {
      await associateContactToCompany(ctx, headers, contactId, companyId);
      associated += 1;
    }
  }

  const lifecycle: LifecycleResult = { company: companyLifecycle, contactsSet, contactsKept };
  return { company_id: companyId, company_existed: companyExisted, contacts: contactsCreated, associated, lifecycle };
}

async function upsertDry(ctx: StepContext): Promise<Record<string, unknown>> {
  // Probe auth without writing anything: list one company (read-safe).
  await callApi<any>(
    ctx,
    `${BASE}/crm/v3/objects/companies?limit=1`,
    'hubspot.companies.list',
    { method: 'GET', headers: authHeaders() },
  );

  const p = profileOf(ctx.run);
  const simulatedContacts: string[] = [];
  if (p.doctor_email) simulatedContacts.push(p.doctor_email);
  if (p.office_manager_email) simulatedContacts.push(p.office_manager_email);

  // Do NOT write hubspot_company_id to the run in dry mode.
  return simulated({ company_id: simId('comp'), contacts: simulatedContacts });
}

export const hubspotSteps: Step[] = [
  {
    key: 'hubspot.upsert',
    wave: 1,
    safetyClass: 'reversible-write',
    dependsOn: ['profile.normalize_intake'],
    maxAttempts: 3,
    isApplicable: () => true,
    runReal: upsertReal,
    runDry: upsertDry,
  },
];
