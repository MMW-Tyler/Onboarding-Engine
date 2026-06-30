import type { Step, StepContext } from '../../types.js';
import { db } from '../../supabase.js';

/**
 * phase0.gate (spec section 08/12): once all Wave 1 steps in the recipe have
 * completed, mark phase0_complete so Wave 2 research is allowed to start.
 * read-safe (it only writes our own bookkeeping), so it runs in dry and live.
 * Dependencies are resolved by the runner before this is enqueued; reaching it
 * means the upstream steps succeeded/simulated/skipped.
 */
async function runGate(ctx: StepContext): Promise<Record<string, unknown>> {
  await db().from('onboarding_runs')
    .update({ phase0_complete: true, wave1_status: 'complete', updated_at: new Date().toISOString() })
    .eq('id', ctx.run.id);
  await ctx.logEvent({ level: 'info', endpoint: 'phase0.gate', response_body: { phase0_complete: true } });
  return { phase0_complete: true };
}

// Depends on every Wave 1 step; createRun filters this to the steps actually in
// the chosen recipe, so partial recipes only wait on the steps they include.
export const phase0Steps: Step[] = [
  {
    key: 'phase0.gate',
    wave: 1,
    safetyClass: 'read-safe',
    dependsOn: [
      'profile.normalize_intake',
      'crawl.detect_platform',
      'slack.create_channel',
      'hubspot.upsert',
      'clickup.clone_template',
      'clickup.master_tracker',
      'drive.create_folders',
      'namecheap.purchase_domain',
      'dns.ghl_records',
      'dns.mailgun_records',
      'mailgun.add_domain',
      'mailgun.verify',
      'warmup.enroll',
      'ghl.provision_subaccount',
      'slack.wave1_rollup',
    ],
    maxAttempts: 3,
    isApplicable: () => true,
    runReal: runGate,
    runDry: runGate,
  },
];
