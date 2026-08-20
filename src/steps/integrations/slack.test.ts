import { describe, it, expect } from 'vitest';
import { buildClientFormPost, buildWave1Content } from './slack.js';

/** Flatten every block's text so assertions can look for content, not layout. */
function textOf(blocks: unknown[]): string {
  return JSON.stringify(blocks);
}

const RUN = {
  id: 'run-1',
  client_name: 'Sereno Pain Management',
  slack_channel_id: 'C123',
  client_profile_json: {
    office_name: 'Sereno Pain Management',
    nap_address: '123 Main St, Los Gatos, CA 95032',
    office_hours: 'Mon-Fri 9-5',
    detected_platform: 'WordPress', // internal bookkeeping, not a client answer
    _restricted: { doctor_mobile: '555-0100' },
  },
  raw_clientform_json: {
    'What is your office address?': '123 Main St, Los Gatos, CA 950032',
    'What are your office hours that you want listed online?': 'Mon-Fri 9-5',
    'Anything else we should know?': 'We share a suite with a physical therapist.',
    responseId: 'ACYDBN-abc123',
  },
};

describe('buildClientFormPost - the onboarding form as it lands in Slack', () => {
  it('posts the normalized answers, grouped, when normalization worked', () => {
    const post = buildClientFormPost(RUN, {
      mapped_keys: ['office_name', 'nap_address', 'office_hours'],
      unmapped: [{ raw_label: 'Anything else we should know?', raw_value: 'We share a suite with a physical therapist.', reason: 'unmapped' }],
    });
    const text = textOf(post.blocks);
    expect(post.mappedCount).toBe(3);
    expect(text).toContain('Onboarding form — Sereno Pain Management');
    expect(text).toContain('123 Main St, Los Gatos, CA 95032');
    // Unmapped answers still make it into the channel, under their own heading.
    expect(post.rawCount).toBe(1);
    expect(text).toContain('Other answers');
    expect(text).toContain('physical therapist');
    // Internal bookkeeping and sensitive values never get posted.
    expect(text).not.toContain('WordPress');
    expect(text).not.toContain('555-0100');
  });

  it('still posts every answer when the zap sends unmappable field labels', () => {
    // The failure mode from the field: Google's raw API response, keyed by
    // internal question ids. normalize_clientform throws, so there's no output.
    const run = {
      ...RUN,
      raw_clientform_json: { '18459843': 'Sereno Pain Management', '28998979': 'Mon-Fri 9-5', responseId: 'ACYDBN-abc' },
    };
    const post = buildClientFormPost(run, null);
    const text = textOf(post.blocks);
    expect(post.mappedCount).toBe(0);
    expect(post.rawCount).toBe(2); // responseId is envelope metadata, not an answer
    expect(text).toContain('Answers as submitted');
    expect(text).toContain('Mon-Fri 9-5');
    expect(text).toContain("didn't come through as question text");
    expect(text).not.toContain('ACYDBN-abc');
  });

  it('flags a submission that could not be matched to a client channel', () => {
    const post = buildClientFormPost(RUN, { mapped_keys: ['office_name'], unmapped: [] }, { unmatched: true });
    expect(textOf(post.blocks)).toContain("Couldn't match this submission to a client channel");
  });

  it('names the client from the profile when the run has no client_name', () => {
    const run = { ...RUN, client_name: null };
    const post = buildClientFormPost(run, { mapped_keys: ['office_name'], unmapped: [] });
    expect(post.fallback).toBe('Onboarding form — Sereno Pain Management');
  });

  it('says so plainly rather than posting an empty message', () => {
    const post = buildClientFormPost({ id: 'run-2', client_profile_json: {}, raw_clientform_json: {} }, null);
    expect(textOf(post.blocks)).toContain('submission arrived empty');
  });
});

describe('buildWave1Content - the client dashboard line', () => {
  const stepRows = (over: Record<string, any> = {}) =>
    new Map<string, any>(Object.entries({ 'slack.create_channel': { status: 'succeeded' }, ...over }));

  it('links the stored WhizHQ portal URL, as its own line', () => {
    const c = buildWave1Content(
      { id: 'run-1', client_name: 'Coastal Aesthetics', client_profile_json: { whizhq_portal_url: 'https://hq.example.com/p/abc123' } },
      stepRows({ 'whizhq.create_client': { status: 'succeeded' } }),
      true,
    );
    expect(c.dashboardLine).toBe('✅  *Client dashboard:*  <https://hq.example.com/p/abc123|Coastal Aesthetics dashboard>');
    // It is its own line, not smuggled into the asset list.
    expect(c.assetLines.join('\n')).not.toContain('hq.example.com');
  });

  // Typed/pasted Slack text auto-links raw URLs but does NOT render <url|label>.
  it('emits a raw URL for the copy-paste roll-up', () => {
    const c = buildWave1Content(
      { id: 'run-1', client_name: 'Coastal Aesthetics', client_profile_json: { whizhq_portal_url: 'https://hq.example.com/p/abc123' } },
      stepRows({ 'whizhq.create_client': { status: 'succeeded' } }),
      false,
    );
    expect(c.dashboardLine).toContain('https://hq.example.com/p/abc123');
    expect(c.dashboardLine).not.toContain('<https://');
  });

  it('does not claim a client exists on a dry run', () => {
    const c = buildWave1Content(
      { id: 'run-1', client_name: 'Coastal Aesthetics', client_profile_json: {} },
      stepRows({ 'whizhq.create_client': { status: 'simulated' } }),
      true,
    );
    expect(c.dashboardLine).toBe('🔵  *Client dashboard:*  no client created in this dry run');
  });

  it('says the client was not created, with the reason, when WhizHQ failed', () => {
    const c = buildWave1Content(
      { id: 'run-1', client_name: 'Coastal Aesthetics', client_profile_json: {} },
      stepRows({ 'whizhq.create_client': { status: 'flagged', last_error: 'Invalid automation key' } }),
      true,
    );
    expect(c.dashboardLine).toBe('⚠️  *Client dashboard:*  not created in WhizHQ — Invalid automation key');
  });

  // WhizHQ config unset: the steps report `skipped` and the roll-up should look
  // exactly as it did before this integration existed, not carry a dead line.
  it('shows nothing at all when the WhizHQ hand-off is skipped or absent', () => {
    const skipped = buildWave1Content(
      { id: 'run-1', client_name: 'Coastal Aesthetics', client_profile_json: {} },
      stepRows({ 'whizhq.create_client': { status: 'skipped' } }),
      true,
    );
    expect(skipped.dashboardLine).toBe('');

    const absent = buildWave1Content({ id: 'run-1', client_name: 'Coastal Aesthetics', client_profile_json: {} }, stepRows(), true);
    expect(absent.dashboardLine).toBe('');
  });
});
