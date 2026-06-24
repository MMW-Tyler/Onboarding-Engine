// ============================================================================
// Spec section 08: advicelocal.listings
//
// TODO !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
// THE ADVICE LOCAL API DETAILS BELOW ARE BEST-EFFORT AND UNVERIFIED.
// Before going live you MUST confirm against Advice Local's real API docs:
//   - Base URL: assumed https://api.advicelocal.com - may differ
//   - Endpoint:  assumed POST /v1/listings - may be /listings, /v2/listings, etc.
//   - Auth:      assumed "Authorization: Bearer <key>" header
//                but may be ?api_key=<key> query param or X-Api-Key header
//   - Payload:   field names below are guesses; verify exact schema
//   - 409:       assumed to mean "listing already exists" (treat as success)
//   - Response:  assumed body.id or body.order_id carries the listing reference
// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
// ============================================================================

import type { Step, StepContext } from '../../types.js';
import { callApi } from '../../lib/http.js';
import { config } from '../../config.js';
import { profileOf, simId, simulated } from './util.js';

/**
 * Advice Local listings worker (spec section 08: advicelocal.listings).
 * Submits the client's NAP (name/address/phone) to Advice Local's listing
 * distribution network. reversible-write: dry-run simulates only, no API call.
 *
 * TODO: verify endpoint, auth scheme, and payload schema against Advice Local
 * docs before enabling in live mode (see top-of-file TODO block).
 */
const BASE = 'https://api.advicelocal.com';

function authHeaders(): Record<string, string> {
  // TODO: verify auth scheme - may be ?api_key=<key> or X-Api-Key header instead
  return { authorization: `Bearer ${config.adviceLocal.apiKey()}` };
}

/** Build the NAP payload from the normalized client profile. */
function buildPayload(p: Record<string, string>): Record<string, string | undefined> {
  return {
    // TODO: verify exact field names against Advice Local API docs
    business_name: p.office_name || p.client_name,
    address:       p.nap_address || p.nap_street,
    city:          p.nap_city,
    state:         p.nap_state,
    zip:           p.nap_zip,
    phone:         p.nap_phone,
    website:       p.website_url,
    email:         p.nap_email || p.doctor_email,
  };
}

async function runReal(ctx: StepContext): Promise<Record<string, unknown>> {
  const p = profileOf(ctx.run);
  const payload = buildPayload(p);

  // Guard: Advice Local cannot create a listing without a business name and address.
  if (!payload.business_name && !payload.address) {
    return { skipped: true, reason: 'insufficient NAP data for listings' };
  }

  // TODO: confirm the correct endpoint path before live use
  const url = `${BASE}/v1/listings`;

  const res = await callApi(ctx, url, 'advicelocal.listings.create', {
    method: 'POST',
    headers: authHeaders(),
    json: payload,
    // 409 = listing already exists; treat as success (idempotent re-submit)
    okStatuses: [409],
  });

  return {
    submitted: true,
    // TODO: verify response shape - id / order_id field names may differ
    order_id:      res.body?.id ?? res.body?.order_id ?? null,
    business:      payload.business_name,
  };
}

async function runDry(ctx: StepContext): Promise<Record<string, unknown>> {
  const p = profileOf(ctx.run);
  const payload = buildPayload(p);

  // Same guard as runReal so the skipped signal is consistent across modes.
  if (!payload.business_name && !payload.address) {
    return { skipped: true, reason: 'insufficient NAP data for listings' };
  }

  // Log the intended payload without calling the API (paid reversible write).
  await ctx.logEvent({
    level: 'info',
    endpoint: 'advicelocal.intended',
    request: payload,
  });

  return simulated({
    submitted: true,
    order_id: simId('al'),
    business: payload.business_name,
  });
}

export const adviceLocalSteps: Step[] = [
  {
    key:          'advicelocal.listings',
    wave:         2,
    safetyClass:  'reversible-write',
    // Gated on the Client MMW onboarding form so listings are submitted once,
    // on the confirmed NAP from the richer form, rather than on thin intake data.
    dependsOn:    ['phase0.gate', 'profile.normalize_clientform'],
    maxAttempts:  3,
    isApplicable: () => true,
    runReal,
    runDry,
  },
];
