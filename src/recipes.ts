/**
 * Recipes: named step bundles (spec section 05). Kept as data so bundles can
 * change without code edits. createRun() validates every key is registered.
 *
 * M4 ships Wave 1 (forms -> Slack/HubSpot/ClickUp/Drive/domain+email stack/GHL)
 * plus the client-form normalization + Slack profile post. The Wave 2 AI research
 * (Prompts 3-6), A2P, Advice Local, and rollup land in M5 and will be added to
 * full_onboarding / wave2_research then.
 */
export const recipes: Record<string, string[]> = {
  // M1 lifecycle test bundle
  echo_demo: ['echo.root', 'echo.child', 'echo.leaf'],

  // Wave 1: standard new client via the Sales Intake form
  full_onboarding: [
    'profile.normalize_intake',
    'crawl.detect_platform',
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
  ],

  // Device-partner client: sending infra, no SEO/research
  device_client_setup: [
    'ghl.provision_subaccount',
    'namecheap.purchase_domain',
    'dns.ghl_records',
    'dns.mailgun_records',
    'mailgun.add_domain',
    'warmup.enroll',
  ],

  // Text-blast-only client
  ghl_only: ['ghl.provision_subaccount'],

  // Email stack for an existing client
  domain_warmup_only: [
    'namecheap.purchase_domain',
    'dns.ghl_records',
    'dns.mailgun_records',
    'mailgun.add_domain',
    'warmup.enroll',
  ],

  // Controlled live-test bundle (spec section 16, M3): smallest reversible
  // write path - create a Slack channel + post to it. Safe to run in live first.
  slack_only: [
    'profile.normalize_intake',
    'slack.create_channel',
    'slack.post_sale_summary',
    'slack.post_intake_profile',
  ],

  // Wave 2 (M4 subset): normalize the client form + post the profile to Slack.
  // AI research (gbp/crawl/seo/press/calendar), A2P, Advice Local, rollup: M5.
  wave2_research: ['profile.normalize_clientform', 'slack.post_clientform_profile'],
};

export function recipeSteps(recipe: string): string[] | undefined {
  return recipes[recipe];
}
