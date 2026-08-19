import { describe, it, expect } from 'vitest';
import { buildClientFormPost } from './slack.js';

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
