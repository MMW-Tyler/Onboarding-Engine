import { describe, expect, it } from 'vitest';
import {
  CLIENTFORM_QUESTIONS, looksLikeQuestionIds, parseFormQuestions, relabelFormBody, cleanTitle,
} from './formLabels.js';
import { mapDeterministic } from '../profile/canonical.js';
import { extractWebsiteDomain } from './domain.js';

// The shape Zapier actually sends: Google Forms API response, ids as keys.
const RAW = {
  id: 'ACYDBNh',
  createTime: '2026-11-06T22:44:44.559Z',
  responseId: 'ACYDBNh',
  lastSubmittedTime: '2026-11-06T22:44:44.559456Z',
  '28998979': 'Example Medispa ',
  '3c1508fb': 'examplemedispa.com ',
  '3849b0f0': '5555550100',
  '4c30b562': '1234567890',
  '18459843': 'The team',
};

describe('looksLikeQuestionIds', () => {
  it('spots a raw Forms API payload', () => {
    expect(looksLikeQuestionIds(RAW)).toBe(true);
  });
  it('leaves a payload keyed by question text alone', () => {
    expect(looksLikeQuestionIds({ 'What is your website URL?': 'a.com', 'Provider Name': 'Dr A' })).toBe(false);
  });
  it('is false for an empty or metadata-only payload', () => {
    expect(looksLikeQuestionIds({})).toBe(false);
    expect(looksLikeQuestionIds({ id: 'x', createTime: 'y' })).toBe(false);
  });
});

describe('relabelFormBody', () => {
  it('replaces ids with question text and keeps metadata', () => {
    const r = relabelFormBody(RAW, CLIENTFORM_QUESTIONS);
    expect(r.relabeled).toBe(5);
    expect(r.unknown).toEqual([]);
    expect(r.body['What is your website URL?']).toBe('examplemedispa.com ');
    expect(r.body.createTime).toBe(RAW.createTime);
    expect(r.body['3c1508fb']).toBeUndefined();
  });
  it('keeps an id it does not know, and reports it', () => {
    const r = relabelFormBody({ ...RAW, deadbeef: 'new question answer' }, CLIENTFORM_QUESTIONS);
    expect(r.unknown).toEqual(['deadbeef']);
    expect(r.body.deadbeef).toBe('new question answer');
  });
  it('never drops an answer when two ids share a title', () => {
    const r = relabelFormBody({ aaaaaaaa: 'one', bbbbbbbb: 'two' }, { aaaaaaaa: 'Same', bbbbbbbb: 'Same' });
    expect(r.body).toEqual({ Same: 'one', 'Same (2)': 'two' });
  });
});

describe('a relabeled submission works downstream', () => {
  const body = relabelFormBody(RAW, CLIENTFORM_QUESTIONS).body;
  it('yields the website domain used to match the Wave 1 run', () => {
    expect(extractWebsiteDomain(body)).toBe('examplemedispa.com');
    expect(extractWebsiteDomain(RAW)).toBeNull();
  });
  it('maps through the clientform normalizer', () => {
    const mapped = mapDeterministic(body, 'clientform');
    expect(mapped.profile.website_url).toBeTruthy();
    expect(mapped.profile.legal_business_name).toBeTruthy();
    expect(mapped.profile.nap_phone).toBeTruthy();
    expect(mapped.profile.usp_reason).toBeTruthy();
    expect(mapped.sensitive.npi ?? Object.keys(mapped.sensitive).length).toBeTruthy();
    expect(mapped.toAI.filter((u) => /^[0-9a-f]{8}$/.test(u.raw_label))).toEqual([]);
  });
  it('every question in the snapshot maps or is routed as sensitive', () => {
    const all = Object.fromEntries(Object.values(CLIENTFORM_QUESTIONS).map((t) => [t, 'answer']));
    const mapped = mapDeterministic(all, 'clientform');
    const placed = Object.keys(mapped.profile).length + Object.keys(mapped.sensitive).length;
    expect(placed).toBeGreaterThanOrEqual(34);
  });
});

describe('parseFormQuestions', () => {
  const page = (data: unknown) => `<script>var FB_PUBLIC_LOAD_DATA_ = ${JSON.stringify(data)};</script>`;
  it('reads entry ids as 8-char hex question ids', () => {
    const html = page([null, [null, [
      [1, 'What is your\n\nwebsite URL?', null, 1, [[1008011515, null, 0]]],
      [2, 'Section header', null, 8, null],
      [3, 'Short id', null, 0, [[89734158, null, 0]]],
    ]]]);
    expect(parseFormQuestions(html)).toEqual({ '3c1508fb': 'What is your website URL?', '05593c0e': 'Short id' });
  });
  it('returns {} for a page it does not recognize', () => {
    expect(parseFormQuestions('<html>sign in</html>')).toEqual({});
    expect(parseFormQuestions('<script>var FB_PUBLIC_LOAD_DATA_ = [oops];</script>')).toEqual({});
  });
  it('cleanTitle collapses whitespace', () => {
    expect(cleanTitle('  a \n\n b  ')).toBe('a b');
  });
});
