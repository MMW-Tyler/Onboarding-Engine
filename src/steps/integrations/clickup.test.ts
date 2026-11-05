import { describe, it, expect } from 'vitest';
import { stateCode, cmsOption, parseMoney, parseDateMs, contractMonths, resolveFields, markdownToPlain, descriptionFor, dependencyEdges, copyTaskBody, needsDetail } from './clickup.js';

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
  it("falls back to the program's own term when the answer says nothing", () => {
    // A blank contract length on a 3-month Whiz Launch used to date the renewal
    // a year out, which is the Day 60 conversion conversation missed entirely.
    expect(contractMonths(undefined, 3)).toBe(3);
    expect(contractMonths('', 3)).toBe(3);
    expect(contractMonths('TBD', 3)).toBe(3);
    // An explicit answer still wins on a monthly program.
    expect(contractMonths('6 months', 3)).toBe(6);
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

describe('onboarding list copy - descriptions keep their links', () => {
  it('writes link targets out so they survive as plain text', () => {
    expect(markdownToPlain('Billing Sheet: [Billing Sheet](https://docs.google.com/spreadsheets/d/abc)'))
      .toBe('Billing Sheet: Billing Sheet (https://docs.google.com/spreadsheets/d/abc)');
    expect(markdownToPlain('[https://app.clickup.com/9017400250/v/dc/8cqn6xu-33917](https://app.clickup.com/9017400250/v/dc/8cqn6xu-33917)'))
      .toBe('https://app.clickup.com/9017400250/v/dc/8cqn6xu-33917');
    expect(markdownToPlain('Complete **within 1 week** of kickoff.\n\n- one\n- two')).toBe('Complete within 1 week of kickoff.\n\n- one\n- two');
  });
  it('prefers the markdown (it has the URLs) over plain text', () => {
    expect(descriptionFor({ id: '1', name: 'x', text_content: 'Billing Sheet:', markdown_description: '[Billing Sheet](https://s)' }))
      .toBe('Billing Sheet (https://s)');
    expect(descriptionFor({ id: '1', name: 'x', text_content: 'Plain only' })).toBe('Plain only');
    expect(descriptionFor({ id: '1', name: 'x' })).toBe('');
  });
  it('puts the description on the task it creates', () => {
    const body = copyTaskBody({ id: '1', name: '0.7 Verify Billing', markdown_description: '[Sheet](https://s)' }, new Map(), new Set(['to do']));
    expect(body.description).toBe('Sheet (https://s)');
  });
});

describe('onboarding list copy - dependencies are re-created', () => {
  const source = [
    { id: 's01', name: '0.1', dependencies: [{ task_id: 's03', depends_on: 's01' }, { task_id: 's02', depends_on: 's01' }] },
    { id: 's02', name: '0.2', dependencies: [{ task_id: 's02', depends_on: 's01' }] },
    { id: 's03', name: '0.3', dependencies: [{ task_id: 's03', depends_on: 's01' }, { task_id: 's09', depends_on: 's03' }, { task_id: 's03', depends_on: 'elsewhere' }] },
    { id: 's09', name: '0.9', dependencies: [{ task_id: 's09', depends_on: 's03' }] },
  ];
  const newIdOf = new Map([['s01', 'n01'], ['s02', 'n02'], ['s03', 'n03'], ['s09', 'n09']]);
  it('maps each edge once, from the waiting side, onto the new ids', () => {
    expect(dependencyEdges(source, newIdOf)).toEqual([['n02', 'n01'], ['n03', 'n01'], ['n09', 'n03']]);
  });
  it('drops edges to tasks outside the list or not copied', () => {
    expect(dependencyEdges(source, new Map([['s01', 'n01'], ['s03', 'n03']]))).toEqual([['n03', 'n01']]);
  });
});

describe('onboarding list copy - reads a task on its own only when needed', () => {
  it('skips the extra read when the list endpoint returned everything', () => {
    expect(needsDetail({ id: '1', name: 'x', dependencies: [], checklists: [], description: 'Sheet:', markdown_description: '[Sheet](https://s)' })).toBe(false);
    expect(needsDetail({ id: '1', name: 'x', dependencies: [], checklists: [] })).toBe(false);
  });
  it('reads it when dependencies, checklists or the markdown are missing', () => {
    expect(needsDetail({ id: '1', name: 'x', checklists: [] })).toBe(true);
    expect(needsDetail({ id: '1', name: 'x', dependencies: [] })).toBe(true);
    expect(needsDetail({ id: '1', name: 'x', dependencies: [], checklists: [], description: 'Sheet:' })).toBe(true);
  });
});
