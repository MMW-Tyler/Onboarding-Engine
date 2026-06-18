import { describe, it, expect, beforeEach } from 'vitest';
import { echoSteps, clearEchoBudget, _resetEchoBudget } from './echo.js';
import type { StepContext } from '../types.js';

const root = echoSteps.find((s) => s.key === 'echo.root')!;

function ctx(failTimes: number, attempt = 1): StepContext {
  return {
    run: { id: 'run-1', raw_intake_json: { echo: { root: { failTimes } } } } as any,
    step: { step_key: 'echo.root' } as any,
    mode: 'dry',
    attempt,
    logEvent: async () => {},
  };
}

describe('echo step lifecycle (M1 fixture)', () => {
  beforeEach(() => _resetEchoBudget());

  it('fails failTimes times then succeeds (budget persists across attempts)', async () => {
    const c = ctx(2);
    await expect(root.runDry(ctx(2, 1))).rejects.toThrow(/simulated failure/);
    await expect(root.runDry(ctx(2, 2))).rejects.toThrow(/simulated failure/);
    const out = await root.runDry(ctx(2, 3));
    expect(out.ok).toBe(true);
    void c;
  });

  it('clearEchoBudget makes the very next attempt succeed (retry = make it work)', async () => {
    // Burn into a "still failing" state.
    await expect(root.runDry(ctx(9, 1))).rejects.toThrow();
    await expect(root.runDry(ctx(9, 2))).rejects.toThrow();
    // User clicks retry -> force success.
    clearEchoBudget('run-1', 'echo.root');
    const out = await root.runDry(ctx(9, 1));
    expect(out.ok).toBe(true);
  });

  it('does not reset to the full configured budget after a clear', async () => {
    await expect(root.runDry(ctx(5, 1))).rejects.toThrow();
    clearEchoBudget('run-1', 'echo.root');
    // Even though failTimes=5 is still in the input, it must stay cleared.
    await expect(root.runDry(ctx(5, 1))).resolves.toMatchObject({ ok: true });
  });
});
