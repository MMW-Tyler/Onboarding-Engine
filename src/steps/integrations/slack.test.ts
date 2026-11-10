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

describe('buildWave1Content - returning clients', () => {
  const OLD_CHANNEL = 'C0A74B923P0';
  const OLD_FOLDER = '1BXEVtSSsbqJFf4SIRAGjR25OP8yKzRz2';
  const rows = (over: Record<string, any> = {}) =>
    new Map<string, any>(Object.entries({
      'slack.create_channel': { status: 'succeeded' },
      'drive.create_folders': { status: 'succeeded', output_json: { reused: true, root_folder_id: OLD_FOLDER, folder_name: 'Venice Kim- O Wellness' } },
      ...over,
    }));
  const returningRun = (profile: Record<string, any> = {}) => ({
    id: 'run-9',
    client_name: 'O Aesthetics & Wellness',
    slack_channel_id: OLD_CHANNEL,
    drive_root_folder_id: OLD_FOLDER,
    client_profile_json: {
      existing_client: 'Yes',
      existing_slack_channel_link: `https://medicalmarketingwhiz1.slack.com/archives/${OLD_CHANNEL}`,
      existing_drive_folder_link: `https://drive.google.com/drive/folders/${OLD_FOLDER}`,
      ...profile,
    },
  });

  it('adds nothing for an ordinary new client', () => {
    const c = buildWave1Content({ id: 'run-1', client_name: 'Coastal Aesthetics', slack_channel_id: 'C999', client_profile_json: {} }, rows({ 'drive.create_folders': { status: 'succeeded', output_json: {} } }), true);
    expect(c.returningLines).toEqual([]);
    expect(c.assetLines[0]).toContain('this channel');
    expect(c.assetLines[0]).not.toContain('reused');
  });

  it('says what it reused when the form gave both links', () => {
    const c = buildWave1Content(returningRun(), rows(), true);
    const text = c.returningLines.join('\n');
    expect(c.returningLines[0]).toBe('⚠️  *Returning client*');
    expect(text).toContain('existing MMW client');
    expect(text).toContain('Reused the existing Slack channel');
    expect(text).toContain('Reused the existing Google Drive folder "Venice Kim- O Wellness"');
    expect(text).not.toContain('No existing');
    expect(c.assetLines.join('\n')).toContain('this channel (existing, reused)');
    expect(c.assetLines.join('\n')).toContain('Open existing Drive folder');
  });

  it('names the extra channel Zapier made, so it can be archived', () => {
    const c = buildWave1Content(returningRun({ zap_created_channel_id: 'C0CANTAD77S' }), rows(), true);
    expect(c.returningLines.join('\n')).toContain('Zapier also created a new channel (<#C0CANTAD77S>)');
  });

  it('warns when a returning client gave no links, or ones it could not read', () => {
    const noLinks = buildWave1Content(
      { id: 'run-9', client_name: 'O Aesthetics & Wellness', slack_channel_id: 'C0CANTAD77S', client_profile_json: { existing_client: 'yes' } },
      rows({ 'drive.create_folders': { status: 'succeeded', output_json: {} } }),
      true,
    );
    const text = noLinks.returningLines.join('\n');
    expect(text).toContain('No existing Slack channel link was given');
    expect(text).toContain('No existing Drive folder link was given');

    const badLink = buildWave1Content(
      { ...returningRun({ existing_slack_channel_link: '#candela--venice-kim' }), slack_channel_id: 'C0CANTAD77S' },
      rows(),
      true,
    );
    expect(badLink.returningLines.join('\n')).toContain(`Couldn't read the Slack channel answer "#candela--venice-kim"`);
  });

  it('flags a possible returning client from an earlier run even when the form said nothing', () => {
    const c = buildWave1Content(
      { id: 'run-10', client_name: 'O Aesthetics & Wellness', slack_channel_id: 'C123NEWONE', client_profile_json: {} },
      rows({ 'drive.create_folders': { status: 'succeeded', output_json: {} } }),
      true,
      { id: 'f3c85f4a', client_name: 'O Aesthetics & Wellness', created_at: '2026-10-16T13:36:24+00:00', website_url: null },
    );
    const text = c.returningLines.join('\n');
    expect(c.returningLines[0]).toBe('⚠️  *Possible returning client*');
    expect(text).toContain('on 2026-10-16 (run `f3c85f4a`)');
    expect(text).toContain('did NOT mark it as existing');
  });
});

describe('buildWave1Content - DMARC on the DNS line', () => {
  const run = { id: 'run-1', client_name: 'Dermagnify', domain: 'dermagnifypx.com', client_profile_json: {} };
  const dnsLine = (dnsRow: Record<string, any>) =>
    buildWave1Content(run, new Map<string, any>(Object.entries({ 'dns.mailgun_records': dnsRow })), true)
      .stackLines.find((l) => l.includes('DNS (Mailgun records)'))!;

  it('says DMARC was published, with its policy', () => {
    const line = dnsLine({ status: 'succeeded', output_json: { dmarc: { action: 'added', policy: 'none' } } });
    expect(line).toBe('✅  DNS (Mailgun records) + DMARC `p=none`');
  });

  it('says an existing DMARC record was kept, and passes on a problem with it', () => {
    const kept = dnsLine({ status: 'succeeded', output_json: { dmarc: { action: 'kept_existing', policy: 'reject' } } });
    expect(kept).toContain('+ DMARC (existing record kept, `p=reject`)');

    const broken = dnsLine({ status: 'succeeded', output_json: { dmarc: { action: 'kept_existing', warning: 'has 2 DMARC records' } } });
    expect(broken).toContain('⚠️ has 2 DMARC records');
  });

  it('claims nothing about DMARC for a run from before the step wrote it, or one that failed', () => {
    expect(dnsLine({ status: 'succeeded', output_json: { added: 5 } })).toBe('✅  DNS (Mailgun records)');
    expect(dnsLine({ status: 'flagged', last_error: 'setHosts failed', output_json: null })).not.toContain('DMARC');
  });
});
