/**
 * Recipes: named step bundles (spec section 05). Kept as data so bundles can
 * change without code edits.
 *
 * M1 ships `echo_demo` only - the real recipes below list their intended steps
 * but those step workers are built in later milestones (M2+). createRun()
 * validates that every step key in a chosen recipe is registered, so selecting
 * a not-yet-built recipe fails loudly rather than silently dropping steps.
 */
export const recipes: Record<string, string[]> = {
  // M1 lifecycle test bundle
  echo_demo: ['echo.root', 'echo.child', 'echo.leaf'],

  // --- real recipes (steps land in later milestones) ---
  full_onboarding: [
    'profile.normalize_intake',
    'slack.create_channel',
    'slack.post_sale_summary',
    'slack.post_intake_profile',
    'hubspot.upsert',
    'clickup.clone_template',
    'clickup.master_tracker',
    'drive.create_folders',
    'namecheap.purchase_domain',
    'dns.ghl_records',
    'dns.mailgun_records',
    'mailgun.add_domain',
    'warmup.enroll',
    'ghl.provision_subaccount',
    'phase0.gate',
    'profile.normalize_clientform',
    'slack.post_clientform_profile',
    'ghl.a2p_registration',
    'gbp.optimize_plan',
    'crawl.site_report',
    'dataforseo.pull',
    'seo.roadmap',
    'research.press_topics',
    'research.content_calendar',
    'advicelocal.listings',
    'wave2.rollup',
  ],
  device_client_setup: [
    'ghl.provision_subaccount',
    'namecheap.purchase_domain',
    'dns.ghl_records',
    'dns.mailgun_records',
    'mailgun.add_domain',
    'warmup.enroll',
  ],
  ghl_only: ['ghl.provision_subaccount'],
  domain_warmup_only: [
    'namecheap.purchase_domain',
    'dns.ghl_records',
    'dns.mailgun_records',
    'mailgun.add_domain',
    'warmup.enroll',
  ],
};

export function recipeSteps(recipe: string): string[] | undefined {
  return recipes[recipe];
}
