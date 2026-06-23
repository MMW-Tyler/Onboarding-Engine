import { Router } from 'express';
import { config } from '../config.js';
import { db } from '../supabase.js';
import { createRun, addStepsToRun } from '../engine/runs.js';
import { toHost, looksLikeDomain } from '../lib/domain.js';

/**
 * The doorbell (spec section 01/05). Zapier POSTs the two Google Form
 * submissions here; the engine writes the run + checklist and works it.
 *  - /webhook/intake     -> full_onboarding (Wave 1)
 *  - /webhook/clientform -> attach Wave 2 to the matching run (gated on phase 0)
 */
export const webhooksRouter = Router();

function verifySecret(req: { header: (n: string) => string | undefined }): boolean {
  if (!config.webhookSecret) return true; // not configured yet (dev)
  const provided = req.header('x-mmw-secret') ?? req.header('X-MMW-Secret');
  return provided === config.webhookSecret;
}

/** Pull a website-like value out of a raw form payload and reduce it to a host. */
function domainFromBody(body: Record<string, unknown>): string | null {
  for (const [label, value] of Object.entries(body)) {
    if (/website|url/i.test(label) && typeof value === 'string' && looksLikeDomain(value)) {
      return toHost(value);
    }
  }
  return null;
}

/** Pull a Slack channel ID Zapier may pass in the intake payload. Matches any
 *  reasonable label spelling. Slack real IDs are C/G + uppercase, but Zapier
 *  test data sometimes substitutes other formats - accept any plausible ID
 *  (>= 6 alphanumeric chars) and let the Slack API itself reject if it's bad. */
function slackChannelFromBody(body: Record<string, unknown>): string | null {
  for (const [label, value] of Object.entries(body)) {
    if (!/slack.*(channel|chan).*id|^channel[_ ]?id$/i.test(label)) continue;
    if (typeof value !== 'string') continue;
    const v = value.trim();
    if (/^[A-Z0-9]{6,}$/i.test(v)) return v;
  }
  return null;
}

webhooksRouter.post('/webhook/intake', async (req, res) => {
  if (!verifySecret(req)) return res.status(401).json({ error: 'bad secret' });
  const body = (req.body ?? {}) as Record<string, unknown>;
  try {
    const result = await createRun({ recipe: 'full_onboarding', input: body });
    // If Zapier created the channel first and passed the ID, attach it to the run
    // so slack.create_channel uses it directly (skips lookup + create).
    const ch = slackChannelFromBody(body);
    if (ch) {
      await db().from('onboarding_runs')
        .update({ slack_channel_id: ch, updated_at: new Date().toISOString() })
        .eq('id', result.runId);
    }
    console.log(`[webhook] intake -> run ${result.runId} (${result.queued.length} steps queued${ch ? `, channel=${ch}` : ''})`);
    return res.status(202).json({ accepted: true, runId: result.runId, slackChannel: ch });
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

webhooksRouter.post('/webhook/clientform', async (req, res) => {
  if (!verifySecret(req)) return res.status(401).json({ error: 'bad secret' });
  const body = (req.body ?? {}) as Record<string, unknown>;
  const domain = domainFromBody(body);

  try {
    // Try to attach Wave 2 to the existing Wave 1 run (so it reuses the Slack channel).
    let runId: string | null = null;
    if (domain) {
      const { data } = await db()
        .from('onboarding_runs')
        .select('id')
        .eq('domain', domain)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      runId = (data?.id as string) ?? null;
    }

    if (runId) {
      await db().from('onboarding_runs').update({ raw_clientform_json: body, updated_at: new Date().toISOString() }).eq('id', runId);
      const added = await addStepsToRun(runId, ['profile.normalize_clientform', 'slack.post_clientform_profile']);
      console.log(`[webhook] clientform -> attached to run ${runId} (${added.length} steps)`);
      return res.status(202).json({ accepted: true, runId, attached: added });
    }

    // No match: normalize and store the data on a standalone run (no Slack post -
    // there is no channel). A human can link it later.
    const result = await createRun({
      recipe: 'wave2_research',
      stepKeys: ['profile.normalize_clientform'],
      clientformInput: body,
    });
    console.log(`[webhook] clientform -> no match, standalone run ${result.runId}`);
    return res.status(202).json({ accepted: true, runId: result.runId, matched: false });
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
