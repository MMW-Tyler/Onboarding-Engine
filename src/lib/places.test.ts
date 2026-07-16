import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { validateAddress } from './places.js';

function mockPlacesResponse(body: unknown, ok = true): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok,
      status: ok ? 200 : 500,
      text: async () => JSON.stringify(body),
    })),
  );
}

describe('validateAddress - Places-backed NAP validation', () => {
  beforeEach(() => {
    vi.stubEnv('GOOGLE_PLACES_API_KEY', 'test-key');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('parses street/city/state/zip from addressComponents, correcting a typo (Sereno ZIP example)', async () => {
    mockPlacesResponse({
      places: [
        {
          id: 'place123',
          formattedAddress: '360 Dardanelli Ln #2G, Los Gatos, CA 95032, USA',
          addressComponents: [
            { longText: '360', shortText: '360', types: ['street_number'] },
            { longText: 'Dardanelli Lane', shortText: 'Dardanelli Ln', types: ['route'] },
            { longText: '2G', shortText: '2G', types: ['subpremise'] },
            { longText: 'Los Gatos', shortText: 'Los Gatos', types: ['locality'] },
            { longText: 'California', shortText: 'CA', types: ['administrative_area_level_1'] },
            { longText: '95032', shortText: '95032', types: ['postal_code'] },
          ],
        },
      ],
    });

    // Client typed the ZIP as "950032" (typo) - Places is the source of truth.
    const result = await validateAddress('360 Dardanelli Ln Ste 2G, Los Gatos, CA 950032', 'Sereno Pain Management');
    expect(result?.complete).toBe(true);
    expect(result?.street).toBe('360 Dardanelli Ln, Ste 2G');
    expect(result?.city).toBe('Los Gatos');
    expect(result?.state).toBe('CA');
    expect(result?.zip).toBe('95032');
    expect(result?.placeId).toBe('place123');
  });

  it('treats a partial match (missing a component) as incomplete rather than guessing', async () => {
    mockPlacesResponse({
      places: [
        {
          id: 'place456',
          addressComponents: [
            { longText: 'Los Gatos', shortText: 'Los Gatos', types: ['locality'] },
            { longText: 'California', shortText: 'CA', types: ['administrative_area_level_1'] },
            // no postal_code component
          ],
        },
      ],
    });
    const result = await validateAddress('somewhere in Los Gatos, CA');
    expect(result?.complete).toBe(false);
    expect(result?.zip).toBeUndefined();
  });

  it('returns null when Places has no match at all', async () => {
    mockPlacesResponse({ places: [] });
    const result = await validateAddress('not a real place');
    expect(result).toBeNull();
  });

  it('throws on a non-ok response so the caller can log it for review', async () => {
    mockPlacesResponse({ error: 'boom' }, false);
    await expect(validateAddress('123 Main St')).rejects.toThrow(/places\.searchText/);
  });
});
