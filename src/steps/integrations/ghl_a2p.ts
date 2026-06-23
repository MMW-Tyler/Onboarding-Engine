/**
 * GoHighLevel A2P / 10DLC registration worker (spec section 08: ghl.a2p_registration).
 *
 * ============================================================
 * TODO - MUST VERIFY BEFORE LIVE USE
 * ============================================================
 * 1. A2P_PATH below is a placeholder. The exact GHL endpoint for initiating
 *    A2P / 10DLC brand + campaign registration must be confirmed against the
 *    current GHL API docs (https://highlevel.stoplight.io/docs/integrations)
 *    and the client's GHL snapshot.
 *
 * 2. The registration payload built here is best-effort from available profile
 *    fields. Real 10DLC requires at minimum: EIN / Tax ID, registered legal
 *    business name (as filed with IRS), business type / entity type, vertical,
 *    campaign use-case category, sample message text (2+), opt-in description,
 *    privacy policy URL, and terms of service URL. None of these are currently
 *    collected in the intake form - they must be added before live submission.
 *
 * 3. GHL_A2P_CUSTOM_FIELD_MAP must be populated from the client's GHL snapshot
 *    before this step can run in live mode. The map is a JSON object of
 *    { ourFieldName: "ghl_custom_field_id", ... } pairs. Without it, the step
 *    will throw in runReal rather than submit incomplete data.
 *
 * 4. GHL may split A2P into multiple calls (brand registration, then campaign
 *    registration). Confirm the sequence against the live API before deploying.
 * ============================================================
 */

import type { Step, StepContext } from '../../types.js';
import { callApi } from '../../lib/http.js';
import { config } from '../../config.js';
import { profileOf, simId, simulated } from './util.js';

const GHL_BASE = 'https://services.leadconnectorhq.com';

/**
 * TODO: Confirm the correct A2P registration path from the GHL API docs.
 * The path below is a reasonable guess based on GHL's location-scoped REST
 * structure but has NOT been validated against a live snapshot.
 */
const A2P_PATH = '/locations/{locationId}/compliance/a2p-registration';

/** Standard headers required by the GHL REST API (spec section 08). */
function ghlHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${config.ghl.apiKey()}`,
    // GHL requires the Version header on every request.
    version: '2021-07-28',
  };
}

/**
 * Parse the field-map env var defensively - an unparseable or missing value
 * leaves fieldMap empty rather than crashing at import time.
 */
function parseFieldMap(): Record<string, string> {
  const raw = config.ghl.a2pFieldMap();
  let fieldMap: Record<string, string> = {};
  try {
    if (raw) fieldMap = JSON.parse(raw) as Record<string, string>;
  } catch {
    /* leave empty - the runReal guard will catch this and throw clearly */
  }
  return fieldMap;
}

/**
 * Build a best-effort A2P payload from the normalized client profile.
 *
 * TODO: Extend this payload once EIN, business type, campaign use-case,
 * sample messages, opt-in language, and policy URLs are collected in intake.
 * The fields below are the non-sensitive identifiers available today.
 */
function buildA2pPayload(
  p: Record<string, string>,
  locationId: string,
  fieldMap: Record<string, string>,
): Record<string, unknown> {
  // Core business identity fields (best-effort from profile).
  const payload: Record<string, unknown> = {
    locationId,
    // Prefer the legal business name; fall back to the office/clinic name.
    businessName: p.legal_business_name || p.office_name || '',
    website: p.website_url || '',
    address: p.nap_address || p.nap_street || '',
    city: p.nap_city || '',
    state: p.nap_state || '',
    zip: p.nap_zip || '',
    phone: p.nap_phone || '',
    email: p.doctor_email || '',
  };

  // If the field map is populated, attach any mapped custom-field values so
  // GHL can route them to the correct snapshot fields on the sub-account.
  if (Object.keys(fieldMap).length > 0) {
    const customFields: Record<string, string> = {};
    for (const [ourKey, ghlFieldId] of Object.entries(fieldMap)) {
      if (p[ourKey]) customFields[ghlFieldId] = p[ourKey]!;
    }
    if (Object.keys(customFields).length > 0) {
      payload.customFields = customFields;
    }
  }

  return payload;
}

// --- runReal ---

async function ghlA2pReal(ctx: StepContext): Promise<Record<string, unknown>> {
  // Guard 1: the sub-account must have been created by ghl.provision_subaccount.
  const locationId = ctx.run.ghl_location_id as string | undefined;
  if (!locationId) {
    throw new Error(
      'ghl.a2p: no ghl_location_id on run (provision_subaccount must succeed first)',
    );
  }

  // Guard 2: the field map must be configured from the GHL snapshot before
  // submitting anything - submitting with no mapping silently produces bad data.
  const fieldMap = parseFieldMap();
  if (Object.keys(fieldMap).length === 0) {
    throw new Error(
      'ghl.a2p: GHL_A2P_CUSTOM_FIELD_MAP not configured - set it from the GHL snapshot before live A2P',
    );
  }

  const p = profileOf(ctx.run);
  const headers = ghlHeaders();
  const payload = buildA2pPayload(p, locationId, fieldMap);

  // POST the registration request.
  // TODO: Replace A2P_PATH with the confirmed endpoint before going live.
  const url = `${GHL_BASE}${A2P_PATH.replace('{locationId}', locationId)}`;
  await callApi<unknown>(ctx, url, 'ghl.a2p.submit', {
    method: 'POST',
    headers,
    json: payload,
  });

  return { submitted: true, location_id: locationId };
}

// --- runDry ---

async function ghlA2pDry(ctx: StepContext): Promise<Record<string, unknown>> {
  const locationId = (ctx.run.ghl_location_id as string | undefined) ?? simId('loc');
  const p = profileOf(ctx.run);
  const fieldMap = parseFieldMap();

  // Log what would be sent so reviewers can inspect the intended payload.
  await ctx.logEvent({
    level: 'info',
    endpoint: 'ghl.a2p.submit (dry)',
    request: buildA2pPayload(p, locationId, fieldMap),
  });

  // Do NOT call the GHL API in dry mode.
  return simulated({
    submitted: true,
    location_id: locationId,
    note: 'A2P is a stub pending GHL snapshot field map + 10DLC data',
  });
}

// --- exported step list ---

export const ghlA2pSteps: Step[] = [
  {
    key: 'ghl.a2p_registration',
    wave: 2,
    safetyClass: 'reversible-write',
    dependsOn: ['profile.normalize_clientform', 'ghl.provision_subaccount'],
    maxAttempts: 3,
    isApplicable: () => true,
    runReal: ghlA2pReal,
    runDry: ghlA2pDry,
  },
];
