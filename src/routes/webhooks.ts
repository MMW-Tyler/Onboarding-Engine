import { Router } from 'express';
import { config } from '../config.js';

export const webhooksRouter = Router();

/**
 * The doorbell (spec section 01/05). Zapier POSTs the two Google Form
 * submissions here. M1 verifies the shared secret and acknowledges; M4 wires
 * these to createRun() with the real recipes (full_onboarding / Wave 2 research)
 * once the form-normalization steps (Prompts 1-2) exist.
 */
function verifySecret(req: { header: (n: string) => string | undefined }): boolean {
  if (!config.webhookSecret) return true; // not configured yet (dev)
  const provided = req.header('x-mmw-secret') ?? req.header('X-MMW-Secret');
  return provided === config.webhookSecret;
}

webhooksRouter.post('/webhook/intake', (req, res) => {
  if (!verifySecret(req)) return res.status(401).json({ error: 'bad secret' });
  console.log('[webhook] intake received', { keys: Object.keys(req.body ?? {}) });
  // TODO (M4): createRun({ recipe: 'full_onboarding', input: req.body })
  return res.status(202).json({ accepted: true, note: 'intake doorbell ack (M1 stub)' });
});

webhooksRouter.post('/webhook/clientform', (req, res) => {
  if (!verifySecret(req)) return res.status(401).json({ error: 'bad secret' });
  console.log('[webhook] clientform received', { keys: Object.keys(req.body ?? {}) });
  // TODO (M4): match to existing run, enqueue Wave 2 (gated on phase0).
  return res.status(202).json({ accepted: true, note: 'clientform doorbell ack (M1 stub)' });
});
