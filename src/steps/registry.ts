import type { Step } from '../types.js';
import { echoSteps } from './echo.js';
import { profileSteps } from './integrations/profile.js';
import { slackSteps } from './integrations/slack.js';
import { hubspotSteps } from './integrations/hubspot.js';
import { clickupSteps } from './integrations/clickup.js';
import { driveSteps } from './integrations/drive.js';
import { namecheapSteps } from './integrations/namecheap.js';
import { dnsSteps } from './integrations/dns.js';
import { mailgunSteps } from './integrations/mailgun.js';
import { warmupSteps } from './integrations/warmup.js';
import { ghlSteps } from './integrations/ghl.js';
import { crawlSteps } from './integrations/crawl.js';
import { phase0Steps } from './integrations/phase0.js';

/**
 * The step catalog (spec section 08). A step_key -> Step map. New integration
 * workers register here as they are built. M1 shipped the echo test steps; M4
 * adds the Wave 1 onboarding workers + form normalization + the phase-0 gate.
 */
const registry = new Map<string, Step>();

export function register(step: Step): void {
  if (registry.has(step.key)) {
    throw new Error(`Duplicate step registration: ${step.key}`);
  }
  registry.set(step.key, step);
}

export function getStep(key: string): Step | undefined {
  return registry.get(key);
}

export function hasStep(key: string): boolean {
  return registry.has(key);
}

export function allSteps(): Step[] {
  return [...registry.values()];
}

// --- register all steps ---
const ALL: Step[][] = [
  echoSteps,
  profileSteps,
  slackSteps,
  hubspotSteps,
  clickupSteps,
  driveSteps,
  namecheapSteps,
  dnsSteps,
  mailgunSteps,
  warmupSteps,
  ghlSteps,
  crawlSteps,
  phase0Steps,
];
for (const group of ALL) for (const s of group) register(s);
