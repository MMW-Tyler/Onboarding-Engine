import { describe, it, expect } from 'vitest';
import { recipes } from './recipes.js';
import { getStep, hasStep } from './steps/registry.js';

/**
 * Recipe wiring guards. These catch the two mistakes that are invisible in a
 * code review and only show up as a run that never finishes in production.
 */

describe('every recipe references registered steps', () => {
  for (const [name, keys] of Object.entries(recipes)) {
    it(name, () => {
      expect(keys.filter((k) => !hasStep(k))).toEqual([]);
    });
  }
});

/**
 * A cycle across hard AND soft dependencies together is a deadlock: a soft dep
 * makes the runner requeue a step until every soft dep is terminal, so two steps
 * that (transitively) wait on each other requeue forever and the run stalls with
 * no error. Hard deps alone can't cycle without blocking, but a hard/soft mix
 * can, which is exactly the trap the Wave 1 roll-up sits in: it soft-waits on
 * whizhq.create_client for the dashboard link, while whizhq.crawl_report
 * soft-waits on the roll-up so it can reply in its thread.
 */
describe('no recipe can deadlock on its dependency graph', () => {
  for (const [name, keys] of Object.entries(recipes)) {
    it(name, () => {
      const selected = new Set(keys);
      // Both kinds of edge, filtered to the steps actually in this recipe -
      // the same filtering createRun() and the runner do.
      const edges = new Map<string, string[]>(
        keys.map((k) => {
          const step = getStep(k)!;
          return [k, [...step.dependsOn, ...(step.softDependsOn ?? [])].filter((d) => selected.has(d))];
        }),
      );

      const state = new Map<string, 'open' | 'closed'>();
      const walk = (key: string, path: string[]): void => {
        if (state.get(key) === 'closed') return;
        if (state.get(key) === 'open') {
          throw new Error(`dependency cycle: ${[...path, key].join(' -> ')}`);
        }
        state.set(key, 'open');
        for (const dep of edges.get(key) ?? []) walk(dep, [...path, key]);
        state.set(key, 'closed');
      };

      expect(() => { for (const k of keys) walk(k, []); }).not.toThrow();
    });
  }
});

/**
 * phase0.gate is what marks Wave 1 complete, and it depends HARD on its list, so
 * anything in it can block the gate by failing. The WhizHQ hand-off is required
 * to fail soft (WhizHQ down must never hold up onboarding), which means it must
 * stay out of that list - see the integration spec's rule 4.
 */
describe('phase0.gate stays out of the fail-soft integrations', () => {
  it('does not depend on any WhizHQ step', () => {
    const gate = getStep('phase0.gate')!;
    expect(gate.dependsOn.filter((d) => d.startsWith('whizhq.'))).toEqual([]);
  });

  it('is reached even when every WhizHQ step is in the recipe', () => {
    const w1 = recipes.full_onboarding!;
    expect(w1).toContain('whizhq.create_client');
    expect(w1).toContain('whizhq.site_bootstrap');
    expect(w1).toContain('whizhq.crawl_report');
    expect(w1.indexOf('phase0.gate')).toBe(w1.length - 1);
  });
});

/**
 * whizhq.crawl_report polls: it throws "not finished yet" and is re-claimed on
 * the `poll` profile's flat cadence. maxAttempts is therefore the wait window,
 * not a failure budget, so it must be large - a step left on the default 3 would
 * flag ~2 minutes into a crawl that takes 10.
 */
describe('the polling step is configured to wait, not to retry', () => {
  it('polls on the flat cadence for about half an hour', () => {
    const step = getStep('whizhq.crawl_report')!;
    expect(step.retryProfile).toBe('poll');
    expect(step.maxAttempts).toBeGreaterThanOrEqual(30);
  });

  // clients/onboard is not idempotent and its failures are either pointless to
  // retry or ambiguous about whether a client was created.
  it('never auto-retries the client creation', () => {
    expect(getStep('whizhq.create_client')!.maxAttempts).toBe(1);
  });
});
