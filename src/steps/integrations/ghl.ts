import type { Step, StepContext } from '../../types.js';
import { db } from '../../supabase.js';
import { callApi } from '../../lib/http.js';
import { config } from '../../config.js';
import { profileOf, simId, simulated } from './util.js';

/**
 * GoHighLevel workers (spec section 08: ghl.provision_subaccount): create a
 * sub-account (location) for the client under the agency, optionally applying a
 * snapshot. reversible-write: simulated in dry-run.
 *
 * TODO: Verify the exact endpoint path, required fields, and Version header date
 * against the current GHL API docs (https://highlevel.stoplight.io/docs/integrations).
 * Snapshot application may require a separate POST /locations/{locationId}/snapshots/apply
 * call after the location is created - GHL's snapshot flow changed between API
 * versions and should be confirmed before going live.
 */
const GHL_BASE = 'https://services.leadconnectorhq.com';

/** Standard headers required by the GHL REST API. */
function ghlHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${config.ghl.apiKey()}`,
    // GHL requires the Version header on every request (spec section 08).
    version: '2021-07-28',
  };
}

// --- provision_subaccount ---

/**
 * Build the location creation payload from the normalized client profile.
 * Fields map to GHL's POST /locations/ body schema.
 */
function locationPayload(ctx: StepContext): Record<string, unknown> {
  const p = profileOf(ctx.run);

  const payload: Record<string, unknown> = {
    // companyId (the agency Company ID) is REQUIRED for agency-level creation.
    companyId: config.ghl.companyId(),
    name: p.office_name || p.client_name || ctx.run.client_name || 'Unknown Client',
    phone: p.nap_phone,
    address: p.nap_street,
    city: p.nap_city,
    state: p.nap_state,
    country: 'US',
    postalCode: p.nap_zip,
    website: p.website_url,
    email: p.doctor_email,
    // GHL commonly requires a prospect contact; populate from the doctor.
    prospectInfo: {
      firstName: p.doctor_first_name || p.office_name || 'Client',
      lastName: p.doctor_last_name || 'Onboarding',
      email: p.doctor_email,
    },
  };

  // Attach snapshot only if the env var is configured; snapshot application may
  // require a follow-up call depending on GHL API version (see TODO above).
  const snapshotId = config.ghl.snapshotId();
  if (snapshotId) {
    payload.snapshotId = snapshotId;
  }

  return payload;
}

async function provisionSubaccountReal(ctx: StepContext): Promise<Record<string, unknown>> {
  if (!config.ghl.companyId()) {
    throw new Error('ghl: GHL_COMPANY_ID not set (the agency Company ID is required to create a sub-account)');
  }
  const headers = ghlHeaders();
  const payload = locationPayload(ctx);

  // POST /locations/ - create the sub-account (location) under the agency.
  const res = await callApi<any>(ctx, `${GHL_BASE}/locations/`, 'ghl.locations.create', {
    method: 'POST',
    headers,
    json: payload,
  });

  // GHL may return the id at the top level or nested under location.
  const id: string = res.body?.id ?? res.body?.location?.id;
  if (!id) throw new Error(`ghl.locations.create: no location id in response: ${JSON.stringify(res.body)}`);

  // Persist the new location id back to the run row so downstream steps can use it.
  await db()
    .from('onboarding_runs')
    .update({ ghl_location_id: id, updated_at: new Date().toISOString() })
    .eq('id', ctx.run.id);

  return { location_id: id };
}

async function provisionSubaccountDry(ctx: StepContext): Promise<Record<string, unknown>> {
  // Probe with a read-safe call to validate the API key without creating anything.
  // locations/search is scoped by companyId at the agency level; include it when set.
  const companyId = config.ghl.companyId();
  const q = companyId ? `?companyId=${encodeURIComponent(companyId)}&limit=1` : '?limit=1';
  await callApi<any>(ctx, `${GHL_BASE}/locations/search${q}`, 'ghl.locations.search', {
    method: 'GET',
    headers: ghlHeaders(),
  });

  // Do not write to the run row in dry mode.
  return simulated({ location_id: simId('loc') });
}

export const ghlSteps: Step[] = [
  {
    key: 'ghl.provision_subaccount',
    wave: 1,
    safetyClass: 'reversible-write',
    dependsOn: ['profile.normalize_intake'],
    maxAttempts: 3,
    isApplicable: () => true,
    runReal: provisionSubaccountReal,
    runDry: provisionSubaccountDry,
  },
];
