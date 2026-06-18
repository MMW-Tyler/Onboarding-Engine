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

/** Derive a bare hostname from a URL string; falls back to empty string on parse failure. */
function domainFrom(websiteUrl: string | undefined): string {
  if (!websiteUrl) return '';
  try {
    return new URL(websiteUrl.startsWith('http') ? websiteUrl : `https://${websiteUrl}`).hostname;
  } catch {
    return '';
  }
}

// --- upsert (company + contacts) ---

async function upsertReal(ctx: StepContext): Promise<Record<string, unknown>> {
  const p = profileOf(ctx.run);
  const headers = authHeaders();

  // 1. Create/upsert the company record.
  const companyProperties: Record<string, string> = {
    name: p.office_name ?? (ctx.run.client_name as string) ?? '',
    domain: domainFrom(p.website_url),
    phone: p.nap_phone ?? '',
    city: p.nap_city ?? '',
    state: p.nap_state ?? '',
  };
  // Remove empty values so we don't overwrite existing CRM data with blanks.
  for (const key of Object.keys(companyProperties)) {
    if (!companyProperties[key]) delete companyProperties[key];
  }

  const companyRes = await callApi<any>(
    ctx,
    `${BASE}/crm/v3/objects/companies`,
    'hubspot.companies.create',
    { method: 'POST', headers, json: { properties: companyProperties } },
  );
  const companyId: string = companyRes.body.id;

  // Persist the company id to the run so downstream steps can reference it.
  await db()
    .from('onboarding_runs')
    .update({ hubspot_company_id: companyId, updated_at: new Date().toISOString() })
    .eq('id', ctx.run.id);

  // 2. Create contacts -- doctor and office manager -- when email is present.
  //    Sensitive email values come from the profile; we never log them raw.
  const contactsCreated: string[] = [];

  const candidates: Array<{ email: string | undefined; firstName?: string; lastName?: string; fullName?: string }> = [
    {
      email: p.doctor_email,
      firstName: p.doctor_first_name,
      lastName: p.doctor_last_name,
    },
    {
      email: p.office_manager_email,
      fullName: p.office_manager_name,
    },
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

    // 409 = contact already exists by email -- that is fine, we just note it.
    await callApi<any>(
      ctx,
      `${BASE}/crm/v3/objects/contacts`,
      'hubspot.contacts.create',
      { method: 'POST', headers, json: { properties: contactProperties }, okStatuses: [409] },
    );

    // Record that we attempted this email (do not log the address value itself).
    contactsCreated.push(candidate.email);
  }

  return { company_id: companyId, contacts: contactsCreated };
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
