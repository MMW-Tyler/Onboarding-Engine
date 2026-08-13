import { describe, it, expect } from 'vitest';
import { stateCode, cmsOption, parseMoney, parseDateMs, contractMonths, resolveFields } from './clickup.js';

describe('stateCode - matches the tracker State dropdown', () => {
  it('accepts codes and full names', () => {
    expect(stateCode('CA')).toBe('CA');
    expect(stateCode('mi')).toBe('MI');
    expect(stateCode('California')).toBe('CA');
    expect(stateCode(' new york ')).toBe('NY');
  });
  it('gives up rather than guessing', () => {
    expect(stateCode('')).toBeUndefined();
    expect(stateCode(undefined)).toBeUndefined();
    expect(stateCode('Ontario')).toBeUndefined();
  });
});

describe('cmsOption - maps a detected platform to the Website CMS options', () => {
  it('maps the platforms the crawler fingerprints', () => {
    expect(cmsOption('WordPress')).toBe('Wordpress');
    expect(cmsOption('Squarespace')).toBe('SquareSpace');
    expect(cmsOption('GoDaddy Website Builder')).toBe('GoDaddy');
    expect(cmsOption('Wix')).toBe('Wix');
  });
  it('falls back to Other for platforms with no option, and skips unknown', () => {
    expect(cmsOption('Duda')).toBe('Other');
    expect(cmsOption('unknown')).toBeUndefined();
    expect(cmsOption(undefined)).toBeUndefined();
  });
});

describe('parseMoney', () => {
  it('pulls the number out of a typed money answer', () => {
    expect(parseMoney('$3,497')).toBe(3497);
    expect(parseMoney('2497/mo')).toBe(2497);
    expect(parseMoney('$1,997.50 setup')).toBe(1997.5);
  });
  it('returns undefined when there is no amount', () => {
    expect(parseMoney('TBD')).toBeUndefined();
    expect(parseMoney('')).toBeUndefined();
    expect(parseMoney('$0')).toBeUndefined();
  });
});

describe('parseDateMs + contractMonths - renewal date maths', () => {
  it('parses ISO and US-typed dates to UTC midnight', () => {
    expect(parseDateMs('2026-08-15')).toBe(Date.UTC(2026, 7, 15));
    expect(parseDateMs('2026-08-15 16:23:45')).toBe(Date.UTC(2026, 7, 15));
    expect(parseDateMs('nope')).toBeUndefined();
  });
  it('reads a contract length, defaulting to 12 months', () => {
    expect(contractMonths('12 months')).toBe(12);
    expect(contractMonths('1 year')).toBe(12);
    expect(contractMonths('6-month')).toBe(6);
    expect(contractMonths(undefined)).toBe(12);
    expect(contractMonths('annual')).toBe(12);
  });
});

describe('resolveFields - names to live ClickUp field/option ids', () => {
  const fields = [
    {
      id: 'f-contract',
      name: 'Contract Type',
      type: 'drop_down',
      type_config: { options: [{ id: 'o-pp', name: 'Practice Pro' }, { id: 'o-ss', name: 'Smart Start' }] },
    },
    { id: 'f-city', name: 'City', type: 'short_text' },
    { id: 'f-signed', name: 'Contract Signed', type: 'date' },
  ];

  it('maps dropdown labels to option ids and passes plain values through', () => {
    const { values, unresolved } = resolveFields(fields, {
      'Contract Type': 'Practice Pro',
      City: 'Los Gatos',
      'Contract Signed': 1786000000000,
    });
    expect(unresolved).toEqual([]);
    expect(values).toEqual([
      { id: 'f-contract', value: 'o-pp' },
      { id: 'f-city', value: 'Los Gatos' },
      { id: 'f-signed', value: 1786000000000 },
    ]);
  });

  it('is case-insensitive on field and option names', () => {
    const { values } = resolveFields(fields, { 'contract type': 'practice pro' });
    expect(values).toEqual([{ id: 'f-contract', value: 'o-pp' }]);
  });

  it('reports renamed fields/options instead of writing a stale id', () => {
    const { values, unresolved } = resolveFields(fields, {
      'Contract Type': 'Platinum',
      'Happiness Level': 'Very Happy',
      City: 'Los Gatos',
    });
    expect(values).toEqual([{ id: 'f-city', value: 'Los Gatos' }]);
    expect(unresolved).toEqual(['Contract Type = "Platinum" (no such option)', 'Happiness Level (no such field)']);
  });

  it('skips empty values so blanks never overwrite a field', () => {
    const { values, unresolved } = resolveFields(fields, { City: '', 'Contract Type': undefined });
    expect(values).toEqual([]);
    expect(unresolved).toEqual([]);
  });
});
