import type { Step, StepContext } from '../../types.js';
import { db } from '../../supabase.js';
import { loadPromptSystem } from '../../lib/anthropic.js';
import { normalizeProfile } from '../../profile/canonical.js';
import { toHost, looksLikeDomain } from '../../lib/domain.js';
import { validateAddress } from '../../lib/places.js';

/**
 * profile.normalize_intake / profile.normalize_clientform (spec section 11, Prompts 1-2).
 * read-safe: runs for real in dry and live. Deterministic mapping first, AI for
 * the rest. Non-sensitive fields go to onboarding_runs.client_profile_json;
 * sensitive fields go to a restricted sub-object (redacted on API output, never
 * logged). The step output records only key names + the unmapped log - no values.
 */
async function runNormalize(
  ctx: StepContext,
  schema: 'intake' | 'clientform',
  promptFile: string,
): Promise<Record<string, unknown>> {
  const raw = (schema === 'intake' ? ctx.run.raw_intake_json : ctx.run.raw_clientform_json) ?? {};
  const systemText = loadPromptSystem(promptFile);

  const { profile, sensitive, unmapped } = await normalizeProfile(raw, schema, systemText);

  await ctx.logEvent({
    level: unmapped.length > 0 ? 'warn' : 'info',
    endpoint: `profile.normalize_${schema}`,
    response_body: { mapped: Object.keys(profile), sensitiveKeys: Object.keys(sensitive), unmappedCount: unmapped.length },
  });

  // Merge into the run profile. Sensitive values live under _restricted and are
  // masked by the redaction helper on every API response (key-name based).
  const existing = (ctx.run.client_profile_json ?? {}) as Record<string, unknown>;
  const existingRestricted = (existing._restricted ?? {}) as Record<string, unknown>;

  // Client MMW form only asks for the office address as one combined question
  // (Wave 1's Sales Intake form has separate street/city/state/zip questions,
  // but Wave 2 does not) - so validate it against Google Places and populate
  // the structured nap_street/nap_city/nap_state/nap_zip fields that
  // advicelocal.listings and ghl.a2p_registration read directly. This also
  // catches client typos (e.g. a mistyped ZIP). Only applied when Places
  // resolves every component - a partial match never overwrites good data
  // with a guess, and always falls back silently (logged for review) rather
  // than blocking the rest of normalization.
  if (schema === 'clientform' && profile.nap_address) {
    const rawAddress = profile.nap_address;
    const bizName = profile.legal_business_name || (existing.office_name as string | undefined);
    try {
      const validated = await validateAddress(rawAddress, bizName);
      if (validated?.complete) {
        profile.nap_street = validated.street!;
        profile.nap_city = validated.city!;
        profile.nap_state = validated.state!;
        profile.nap_zip = validated.zip!;
        const rebuilt = `${validated.street}, ${validated.city}, ${validated.state} ${validated.zip}`;
        if (rebuilt !== rawAddress) {
          await ctx.logEvent({
            level: 'info',
            endpoint: 'profile.validate_address',
            response_body: { corrected: true, raw: rawAddress, validated: rebuilt, place_id: validated.placeId },
          });
        }
        profile.nap_address = rebuilt;
      } else {
        unmapped.push({ raw_label: 'nap_address', raw_value: rawAddress, reason: validated ? 'places_partial_match' : 'places_no_match' });
      }
    } catch (err) {
      unmapped.push({ raw_label: 'nap_address', raw_value: rawAddress, reason: `places_error:${err instanceof Error ? err.message : String(err)}` });
    }
  }

  // Wave 1 -> Wave 2 fallbacks: the Sales Intake form doesn't capture
  // focus_services / geo_targets / ideal_patient / differentiators directly, but
  // most of those can be inferred well enough for Wave 2 to produce useful
  // drafts. When the (richer) Client MMW form arrives later, profile.normalize_
  // clientform overwrites these with the real values. Only synthesize when the
  // Wave 2 field isn't already on the profile.
  const fallbacks: Record<string, string> = {};
  if (schema === 'intake') {
    const have = (k: string) => Boolean((existing as Record<string, unknown>)[k]) || Boolean(profile[k]);
    if (!have('focus_services') && profile.client_specialty) {
      fallbacks.focus_services = profile.client_specialty;
    }
    if (!have('geo_targets')) {
      const parts = [profile.nap_city, profile.nap_state].filter(Boolean);
      if (parts.length) fallbacks.geo_targets = parts.join(', ');
    }
  }

  const merged = {
    ...existing,
    ...fallbacks,
    ...profile,
    _restricted: { ...existingRestricted, ...sensitive },
  };

  const patch: Record<string, unknown> = { client_profile_json: merged, updated_at: new Date().toISOString() };
  if (schema === 'intake') {
    if (profile.office_name) patch.client_name = profile.office_name;
    if (profile.package) patch.package = profile.package;
    // Only set a domain when the website value actually looks like one, so a
    // client typing "n/a" or leaving junk doesn't poison the domain steps.
    if (profile.website_url && looksLikeDomain(profile.website_url)) {
      patch.domain = toHost(profile.website_url);
    }
  }
  await db().from('onboarding_runs').update(patch).eq('id', ctx.run.id);

  // Returned output carries NO sensitive values - just names + the review log.
  return {
    schema,
    mapped_keys: Object.keys(profile),
    sensitive_keys: Object.keys(sensitive),
    unmapped,
  };
}

export const profileSteps: Step[] = [
  {
    key: 'profile.normalize_intake',
    wave: 1,
    safetyClass: 'read-safe',
    dependsOn: [],
    maxAttempts: 2,
    retryProfile: 'ai',
    isApplicable: () => true,
    runReal: (ctx) => runNormalize(ctx, 'intake', '01-normalize-intake.md'),
    runDry: (ctx) => runNormalize(ctx, 'intake', '01-normalize-intake.md'),
  },
  {
    key: 'profile.normalize_clientform',
    wave: 2,
    safetyClass: 'read-safe',
    dependsOn: [],
    maxAttempts: 2,
    retryProfile: 'ai',
    isApplicable: (run) => !!run.raw_clientform_json,
    runReal: (ctx) => runNormalize(ctx, 'clientform', '02-normalize-clientform.md'),
    runDry: (ctx) => runNormalize(ctx, 'clientform', '02-normalize-clientform.md'),
  },
];
