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

/** Search a HubSpot CRM object by an exact property match; return the first id. */
async function searchId(
  ctx: StepContext,
  headers: Record<string, string>,
  object: 'companies' | 'contacts',
  propertyName: string,
  value: string,
): Promise<string | null> {
  if (!value) return null;
  const res = await callApi<any>(ctx, `${BASE}/crm/v3/objects/${object}/search`, `hubspot.${object}.search`, {
    method: 'POST',
    headers,
    json: { filterGroups: [{ filters: [{ propertyName, operator: 'EQ', value }] }], properties: [propertyName], limit: 1 },
  });
  return (res.body?.results?.[0]?.id as string | undefined) ?? null;
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

  let existingCompanyId: string | null = null;
  for (const [prop, value] of companyLookups(name, domain)) {
    existingCompanyId = await searchId(ctx, headers, 'companies', prop, value);
    if (existingCompanyId) break;
  }
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
    let contactId = await searchId(ctx, headers, 'contacts', 'email', candidate.email);
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

  return { company_id: companyId, company_existed: companyExisted, contacts: contactsCreated, associated };
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
