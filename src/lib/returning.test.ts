import { describe, it, expect } from 'vitest';
import { isYesAnswer, slackChannelIdFrom, driveFolderIdFrom, readReturningAnswers, findPriorRun } from './returning.js';

describe('isYesAnswer', () => {
  it('reads the ways a rep says yes', () => {
    for (const v of ['Yes', 'yes', ' YES ', 'Y', 'yes - device client upgrading', 'Existing client', 'true']) {
      expect(isYesAnswer(v)).toBe(true);
    }
  });
  it('treats no, blank and anything else as no', () => {
    for (const v of ['No', 'no', '', '   ', 'n/a', 'not sure', 'yesterday', null, undefined]) {
      expect(isYesAnswer(v)).toBe(false);
    }
  });
});

describe('slackChannelIdFrom', () => {
  it('reads the id out of a channel "Copy link" URL', () => {
    expect(slackChannelIdFrom('https://medicalmarketingwhiz1.slack.com/archives/C0A74B923P0')).toBe('C0A74B923P0');
    // A message link copied by mistake still names the channel.
    expect(slackChannelIdFrom('https://medicalmarketingwhiz1.slack.com/archives/C0A74B923P0/p1792157738600479')).toBe('C0A74B923P0');
  });
  it('reads the web client URL and a bare id', () => {
    expect(slackChannelIdFrom('https://app.slack.com/client/T03BL4K35L2/C0AKEF9787L')).toBe('C0AKEF9787L');
    expect(slackChannelIdFrom('  C0AKEF9787L ')).toBe('C0AKEF9787L');
    expect(slackChannelIdFrom('G01ABCDEF23')).toBe('G01ABCDEF23');
  });
  it('does not mistake a channel name for an id', () => {
    expect(slackChannelIdFrom('#candela--venice-kim')).toBeNull();
    expect(slackChannelIdFrom('grandmother-dental')).toBeNull();
    expect(slackChannelIdFrom('')).toBeNull();
    expect(slackChannelIdFrom(null)).toBeNull();
  });
});

describe('driveFolderIdFrom', () => {
  it('reads folder URLs in their usual shapes', () => {
    expect(driveFolderIdFrom('https://drive.google.com/drive/folders/1BXEVtSSsbqJFf4SIRAGjR25OP8yKzRz2')).toBe('1BXEVtSSsbqJFf4SIRAGjR25OP8yKzRz2');
    expect(driveFolderIdFrom('https://drive.google.com/drive/u/0/folders/1onszR65gZ__d2IUmD8a1g_K7bYinL4wf?usp=drive_link')).toBe('1onszR65gZ__d2IUmD8a1g_K7bYinL4wf');
    expect(driveFolderIdFrom('https://drive.google.com/open?id=1BXEVtSSsbqJFf4SIRAGjR25OP8yKzRz2')).toBe('1BXEVtSSsbqJFf4SIRAGjR25OP8yKzRz2');
    expect(driveFolderIdFrom('1BXEVtSSsbqJFf4SIRAGjR25OP8yKzRz2')).toBe('1BXEVtSSsbqJFf4SIRAGjR25OP8yKzRz2');
  });
  it('rejects a folder name', () => {
    expect(driveFolderIdFrom('Venice Kim- O Wellness')).toBeNull();
    expect(driveFolderIdFrom(undefined)).toBeNull();
  });
});

describe('readReturningAnswers', () => {
  it('reads all three answers from the normalized profile', () => {
    const a = readReturningAnswers({
      existing_client: 'Yes',
      existing_slack_channel_link: 'https://medicalmarketingwhiz1.slack.com/archives/C0A74B923P0',
      existing_drive_folder_link: 'https://drive.google.com/drive/folders/1BXEVtSSsbqJFf4SIRAGjR25OP8yKzRz2',
    });
    expect(a).toEqual({
      saidExisting: true,
      slackAnswer: 'https://medicalmarketingwhiz1.slack.com/archives/C0A74B923P0',
      slackChannelId: 'C0A74B923P0',
      driveAnswer: 'https://drive.google.com/drive/folders/1BXEVtSSsbqJFf4SIRAGjR25OP8yKzRz2',
      driveFolderId: '1BXEVtSSsbqJFf4SIRAGjR25OP8yKzRz2',
    });
  });
  it('keeps an unreadable answer so the roll-up can quote it back', () => {
    const a = readReturningAnswers({ existing_client: 'yes', existing_slack_channel_link: '#candela--venice-kim' });
    expect(a.slackAnswer).toBe('#candela--venice-kim');
    expect(a.slackChannelId).toBeNull();
  });
  it('is all empty for an ordinary new client', () => {
    expect(readReturningAnswers({ office_name: 'Coastal Aesthetics' })).toEqual({
      saidExisting: false, slackAnswer: null, slackChannelId: null, driveAnswer: null, driveFolderId: null,
    });
  });
});

describe('findPriorRun', () => {
  const current = { id: 'new', client_name: 'O Aesthetics and Wellness', created_at: '2026-11-02T10:00:00+00:00', website_url: 'https://o-aestheticsandwellness.com/' };

  it('matches an earlier run on the client website', () => {
    const prior = findPriorRun(current, [
      { id: 'other', client_name: 'Coastal Aesthetics', created_at: '2026-10-01T10:00:00+00:00', website_url: 'coastal.com' },
      { id: 'old', client_name: 'O Wellness', created_at: '2026-10-16T13:36:24+00:00', website_url: 'o-aestheticsandwellness.com' },
    ]);
    expect(prior?.id).toBe('old');
  });

  it('matches on the practice name when the website differs ("&" vs "and")', () => {
    const prior = findPriorRun({ ...current, website_url: null }, [
      { id: 'old', client_name: 'O Aesthetics & Wellness', created_at: '2026-10-16T13:36:24+00:00', website_url: null },
    ]);
    expect(prior?.id).toBe('old');
  });

  it('ignores the run itself, later runs and unrelated practices', () => {
    expect(findPriorRun(current, [
      { ...current },
      { id: 'later', client_name: 'O Aesthetics and Wellness', created_at: '2026-12-01T00:00:00+00:00', website_url: null },
      { id: 'other', client_name: 'Coastal Aesthetics', created_at: '2026-10-01T10:00:00+00:00', website_url: 'coastal.com' },
    ])).toBeNull();
  });

  it('picks the most recent earlier match', () => {
    const prior = findPriorRun(current, [
      { id: 'first', client_name: 'O Aesthetics and Wellness', created_at: '2026-07-01T00:00:00+00:00', website_url: null },
      { id: 'second', client_name: 'O Aesthetics and Wellness', created_at: '2026-10-16T00:00:00+00:00', website_url: null },
    ]);
    expect(prior?.id).toBe('second');
  });
});
