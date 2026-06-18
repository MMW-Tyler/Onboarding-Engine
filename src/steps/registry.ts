import type { Step } from '../types.js';
import { echoSteps } from './echo.js';

/**
 * The step catalog (spec section 08). A step_key -> Step map. New integration
 * workers register here as they are built (M2+). M1 ships the echo test steps.
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

// --- register M1 steps ---
for (const s of echoSteps) register(s);
