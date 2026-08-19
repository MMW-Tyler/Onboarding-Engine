/**
 * Recipes: named step bundles (spec section 05). Kept as data so bundles can
 * change without code edits. createRun() validates every key is registered.
 *
 * Wave 1 (forms -> Slack/HubSpot/ClickUp/Drive/domain+email stack/GHL) is the
 * automated pipeline. The Client MMW onboarding form no longer kicks off the
 * original Wave 2 research chain - see clientform_delivery below.
 */
export const recipes: Record<string, string[]> = {
  // M1 lifecycle test bundle
  echo_demo: ['echo.root', 'echo.child', 'echo.leaf'],

  // Wave 1: account setup from the Sales Intake form. Runs, completes, and then
  // HOLDS at phase0 - Wave 2 is added later by the Client MMW onboarding form
  // webhook (/webhook/clientform), so the AI drafts are generated once, on the
  // richer onboarding-form data, rather than twice on thin intake data.
  full_onboarding: [
    'profile.normalize_intake',
    'crawl.detect_platform',
    'slack.create_channel',
    'hubspot.upsert',
    'clickup.clone_template',
    // Practice Pro clients also get the onboarding checklist list duplicated
    // into the New Client Onboarding folder (skipped for other packages).
    'clickup.onboarding_list',
    'clickup.master_tracker',
    'drive.create_folders',
    'namecheap.purchase_domain',
    'mailgun.add_domain',
    'dns.mailgun_records',
    'dns.ghl_records',
    'mailgun.verify',
    'warmup.enroll',
    'ghl.provision_subaccount',
    // One consolidated Slack post (assets + links + detected platform). Replaces
    // the old sale-summary / profile reposts - the Zap already posts the form.
    'slack.wave1_rollup',
    'phase0.gate',
  ],

  // Device-partner client: sending infra, no SEO/research
  device_client_setup: [
    'ghl.provision_subaccount',
    'namecheap.purchase_domain',
    'mailgun.add_domain',
    'dns.mailgun_records',
    'dns.ghl_records',
    'mailgun.verify',
    'warmup.enroll',
  ],

  // Text-blast-only client
  ghl_only: ['ghl.provision_subaccount'],

  // Email stack for an existing client (also the isolated domain-purchase test
  // bundle: buy -> mailgun -> DNS -> warmup, nothing else).
  domain_warmup_only: [
    'namecheap.purchase_domain',
    'mailgun.add_domain',
    'dns.mailgun_records',
    'dns.ghl_records',
    'mailgun.verify',
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

  // What the Client MMW onboarding form triggers now (2026-08-19, Tyler): the
  // form is normalized and posted to the client's Slack channel, and the engine
  // STOPS there. The old plan - keyword research, AI drafts, Advice Local
  // listings, A2P - was dropped: it duplicated work the team already does in
  // other tools, and nobody wanted the engine reaching into them. Attached to
  // the matching Wave 1 run by /webhook/clientform (so it reuses that run's
  // Slack channel); listed here for manual/standalone runs.
  clientform_delivery: [
    'profile.normalize_clientform',
    'slack.post_clientform_profile',
  ],

  // The original Wave 2 research chain. NOT triggered by anything automatically
  // any more - kept as a hand-pickable bundle in the dashboard for the day
  // someone wants a one-off research pass on a client. Nothing runs these unless
  // a human selects them.
  wave2_research: [
    'profile.normalize_clientform',
    'slack.post_clientform_profile',
    'gbp.optimize_plan',
    'crawl.site_report',
    'dataforseo.pull',
    'seo.roadmap',
    'research.press_topics',
    'research.content_calendar',
    'advicelocal.listings',
    'ghl.a2p_registration',
    'wave2.rollup',
  ],
};

export function recipeSteps(recipe: string): string[] | undefined {
  return recipes[recipe];
}
