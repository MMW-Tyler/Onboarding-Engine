import type { Step, StepContext } from '../../types.js';
import { db } from '../../supabase.js';
import { loadPromptSystem } from '../../lib/anthropic.js';
import { normalizeProfile } from '../../profile/canonical.js';
import { toHost, looksLikeDomain } from '../../lib/domain.js';

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
  const merged = {
    ...existing,
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
