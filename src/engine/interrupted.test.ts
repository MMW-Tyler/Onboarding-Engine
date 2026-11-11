import { describe, expect, it } from 'vitest';
import { interruptedReason } from './runner.js';
import { redact } from '../redact.js';
import { buildAlertText } from '../alerts.js';
import { normalizeName } from '../routes/webhooks.js';

describe('interruptedReason', () => {
  it('stops the writes that would duplicate', () => {
    for (const key of ['namecheap.purchase_domain', 'ghl.provision_subaccount', 'clickup.clone_template',
      'clickup.master_tracker', 'drive.create_folders', 'whizhq.create_client']) {
      expect(interruptedReason(key, key.startsWith('namecheap') ? 'costly' : 'reversible-write')).toMatch(/Interrupted by a restart/);
    }
  });
  it('lets safe writes and reads run again', () => {
    expect(interruptedReason('slack.create_channel', 'reversible-write')).toBeNull();
    expect(interruptedReason('clickup.onboarding_list', 'reversible-write')).toBeNull();
    expect(interruptedReason('dns.mailgun_records', 'reversible-write')).toBeNull();
    expect(interruptedReason('profile.normalize_intake', 'read-safe')).toBeNull();
  });
  it('stops any costly step it has never heard of', () => {
    expect(interruptedReason('future.paid_thing', 'costly')).toMatch(/charge/);
  });
});

describe('redact: secrets in URLs', () => {
  it('masks the Namecheap key and the relay secret', () => {
    const url = 'https://relay.example.com/nc.php?s=RELAYSECRET&env=live&ApiUser=mmw&ApiKey=abc123DEF&UserName=mmw&Command=namecheap.domains.check&DomainList=foopx.com';
    const out = redact({ url }) as { url: string };
    expect(out.url).not.toContain('RELAYSECRET');
    expect(out.url).not.toContain('abc123DEF');
    expect(out.url).toContain('DomainList=foopx.com');
    expect(out.url).toContain('ApiUser=mmw');
    expect(out.url).toContain('Command=namecheap.domains.check');
  });
  it('leaves ordinary text and parameters alone', () => {
    expect(redact('status=ok&pages=3')).toBe('status=ok&pages=3');
    expect(redact('https://a.com/x?clientId=12&class=s')).toBe('https://a.com/x?clientId=12&class=s');
  });
});

describe('buildAlertText', () => {
  const run: any = { id: 'r1', client_name: 'Example Clinic', mode: 'live' };
  it('names the client, the step and the reason', () => {
    const t = buildAlertText(run, 'hubspot.upsert', 'HTTP 400\nbad email');
    expect(t).toContain('Example Clinic');
    expect(t).toContain('hubspot.upsert');
    expect(t).toContain('HTTP 400 bad email');
  });
  it('labels a dry run', () => {
    expect(buildAlertText({ ...run, mode: 'dry' }, 's', 'x')).toContain('dry run');
  });
});

describe('normalizeName', () => {
  it('ignores case, punctuation and legal suffixes', () => {
    expect(normalizeName('Eunoia MediSpa, LLC')).toBe(normalizeName('eunoia medispa '));
    expect(normalizeName('O Aesthetics & Wellness')).toBe('o aesthetics and wellness');
  });
});
