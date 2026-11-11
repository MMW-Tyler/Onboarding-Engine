/**
 * Google Forms question ids -> question text.
 *
 * The Client MMW onboarding form zap forwards Google's raw Forms API response:
 * answers keyed by an 8-character hex `questionId` ("18459843") instead of the
 * question text. Nothing downstream can read that: the normalizer maps 0 fields,
 * the website answer can't be found so the submission matches no client, and the
 * form ends up in the fallback channel as a wall of ids. Every submission from
 * 2026-09-11 to 2026-11-06 went that way.
 *
 * The id is not opaque. It is the form's public entry id (the number in
 * `entry.681150841`) written in hex, and the public form page lists every entry
 * id next to its question text. So the engine translates the keys itself rather
 * than depending on how the zap is wired:
 *
 *   1. a snapshot of the form's questions baked in below (always available), and
 *   2. a live read of the public form page, cached for an hour, laid over the
 *      snapshot so a question added or reworded later is picked up without a
 *      deploy. A failed read just means the snapshot is used.
 *
 * A payload that already has question text as keys (a fixed zap, a Sheets-row
 * trigger, the replay script) passes through untouched.
 */

/** Snapshot of the MMW Onboarding Form, read from the public form 2026-11-11. */
export const CLIENTFORM_QUESTIONS: Record<string, string> = {
  '28998979': 'What is the Legal Name of your business?',
  '0cf6a473': 'Provider Name',
  '081da186': 'What year was your practice founded?',
  '522859ca': 'Where did you go to undergrad?',
  '7b0fac9c': 'Where did you go to Medical School and what year did you graduate?',
  '6b43e5a3': 'Where did you do your residency?',
  '7807b4cf': 'What state(s) are you licensed to practice in?',
  '4c30b562': 'What is your NPI#? (we need this for claiming & verification of Healthgrades, Vitals, WebMD profiles)',
  '6ed398ce': 'What is your DEA Number (we need this for claiming & verification of Healthgrades, Vitals, WebMD profiles)',
  '162462a4': 'What is your State License Number (we need this for claiming & verification of Healthgrades, Vitals, WebMD profiles)',
  '3849b0f0': 'What is your OFFICE PHONE NUMBER that you want listed on Google and your other profiles?',
  '7f3defcf': 'What is the EXACT OFFICE ADDRESS that you want listed on Google and your other profiles? Type it exactly how you want it (St. or Street, Suite or Ste or #). Please tell us exactly as this is extremely important for SEO.',
  '605c3709': 'Do you have other locations? If so please list those below with their correct addresses.',
  '3f519165': 'Besides the city that your office is located in, please tell us up to 9 other cities that you want us to target in your area. If you leave this blank we will only target your town....so please write in up to 9 additional nearby suburbs or cities that people would realistically drive from.',
  '0c5f4d02': 'What is the OFFICE EMAIL ADDRESS that you want listed on Google and your other profiles?',
  '6ebcaaf9': 'What are your office hours that you want listed online?',
  '65a429fc': 'What is the best phone number to reach you for when we need to contact you directly?',
  '4c730109': 'Who will be the point person for the marketing program at your office? (please list name and email address below)',
  '3c1508fb': 'What is your website URL?',
  '1e703490': 'What is your website LOGIN? We need the URL to the login page, the username and the password to your Wordpress, or other website platform',
  '1cad9203': 'What is your domain LOGIN and PASSWORD? This is where you purchased your www.yourwebsitename.com (Usually Godaddy, Namecheap, etc)?',
  '0ca65087': 'Where are your website DNS settings managed? (provide logins if different than your domain registrar)',
  '523c391a': 'Do you have a Youtube Channel? If yes, please link below.',
  '4f4e5d71': 'How many emails do you have? (choose one)',
  '356ec732': 'What is your average monthly revenue?',
  '3cc8ff28': 'What are your top services that you want to grow?',
  '0c386567': 'What do you think makes your office unique? (procedures offered, extra training, time spent with patients, prevention focus, etc). Why should a patient choose you over another office?',
  '43fb6f89': 'Please Describe Your Ideal Patient? Please include demographics such as gender, age, income level, education level. What problems or symptoms do they have that you can help?',
  '0fb08abd': 'What are your board-certifications and awards? For example: Board Certified OBGYN, Best of Dallas TX, Top Docs Award, Patient\'s Choice Award, Center of Excellence, North American Menopause Society, Board Certified Obesity Medicine, etc. Please list ALL below!!! We need these to leverage your credibility and experience.',
  '609edc03': 'Are you involved in any fitness groups, clubs, etc? Please list below.',
  '6c2218d5': 'What % of your practice is insurance vs cash services?',
  '05593c0e': 'Do you offer any financing options such as Care Credit or Cherry Financing for patients? Please list below.',
  '5c30dc8c': 'What is Your Lifetime Patient Value $$? (How much does the average patient spend on services at your office over their lifetime)',
  '4a2067e1': 'When is your birthday? Also list birthdays of other doctors or providers if applicable.',
  '7409a723': 'What are your hobbies and interests?*',
  '18459843': "What was the biggest 'unique selling point' that made you say YES to our program?",
  '4819e1cd': 'Program agreement: single point person, monthly Zoom meetings, raise concerns with your Marketing Whiz first',
};

const QUESTION_ID = /^[0-9a-f]{8}$/;

/** Google Forms API / Zapier envelope fields that ride along with the answers. */
const META_KEYS = new Set(['id', 'createtime', 'responseid', 'lastsubmittedtime', 'formid', 'respondentemail']);

function isMetaKey(key: string): boolean {
  return META_KEYS.has(key.trim().toLowerCase().replace(/[\s_]+/g, ''));
}

/** Collapse the newlines and double spaces Google keeps in a question title. */
export function cleanTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim();
}

/**
 * True when the payload's answer keys are question ids rather than question
 * text: at least half of the non-metadata keys are 8 hex characters.
 */
export function looksLikeQuestionIds(body: Record<string, unknown>): boolean {
  const keys = Object.keys(body).filter((k) => !isMetaKey(k));
  if (keys.length === 0) return false;
  const ids = keys.filter((k) => QUESTION_ID.test(k.trim().toLowerCase()));
  return ids.length * 2 >= keys.length;
}

/**
 * Pull `{ questionId: title }` out of a public Google Form page. The page embeds
 * the whole form as a JSON array (`FB_PUBLIC_LOAD_DATA_`); each item carries its
 * title and one or more entries whose numeric id, in hex, is the API questionId.
 * Returns {} for anything that doesn't look like that, never throws.
 */
export function parseFormQuestions(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  const m = html.match(/FB_PUBLIC_LOAD_DATA_\s*=\s*(\[[\s\S]*?\])\s*;\s*<\/script>/);
  if (!m) return out;
  let data: unknown;
  try {
    data = JSON.parse(m[1]!);
  } catch {
    return out;
  }
  const items = (data as any)?.[1]?.[1];
  if (!Array.isArray(items)) return out;
  for (const item of items) {
    if (!Array.isArray(item)) continue;
    const title = typeof item[1] === 'string' ? cleanTitle(item[1]) : '';
    const entries = Array.isArray(item[4]) ? item[4] : [];
    for (const entry of entries) {
      const id = Array.isArray(entry) ? entry[0] : null;
      if (typeof id !== 'number' || !Number.isFinite(id) || !title) continue;
      out[(id >>> 0).toString(16).padStart(8, '0')] = title;
    }
  }
  return out;
}

const CACHE_MS = 60 * 60 * 1000;
const cache = new Map<string, { at: number; map: Record<string, string> }>();

/** Live read of a public form's questions. Cached; {} on any failure. */
export async function fetchFormQuestions(url: string): Promise<Record<string, string>> {
  if (!url) return {};
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.map;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'Mozilla/5.0' } });
    if (!res.ok) return hit?.map ?? {};
    const map = parseFormQuestions(await res.text());
    // An empty parse means Google changed the page, not that the form has no
    // questions. Keep whatever we had rather than caching nothing for an hour.
    if (Object.keys(map).length === 0) return hit?.map ?? {};
    cache.set(url, { at: Date.now(), map });
    return map;
  } catch {
    return hit?.map ?? {};
  } finally {
    clearTimeout(timer);
  }
}

export interface RelabelResult {
  body: Record<string, unknown>;
  /** how many id keys were replaced with question text */
  relabeled: number;
  /** id keys with no known question (kept as-is so the answer is not lost) */
  unknown: string[];
}

/**
 * Replace question-id keys with question text. Keys that are not ids, and ids
 * with no known question, are kept unchanged. If two ids resolve to the same
 * text the second gets a " (2)" suffix so neither answer is dropped.
 */
export function relabelFormBody(body: Record<string, unknown>, questions: Record<string, string>): RelabelResult {
  const out: Record<string, unknown> = {};
  const unknown: string[] = [];
  let relabeled = 0;
  for (const [key, value] of Object.entries(body)) {
    const id = key.trim().toLowerCase();
    const title = QUESTION_ID.test(id) ? questions[id] : undefined;
    if (!title) {
      if (QUESTION_ID.test(id) && !isMetaKey(key)) unknown.push(key);
      out[key] = value;
      continue;
    }
    let label = title;
    for (let n = 2; label in out; n++) label = `${title} (${n})`;
    out[label] = value;
    relabeled++;
  }
  return { body: out, relabeled, unknown };
}

/**
 * The one call the clientform webhook makes: translate a question-id payload
 * using the snapshot plus a live read of the form. A payload already keyed by
 * question text is returned as it came.
 */
export async function resolveClientFormLabels(body: Record<string, unknown>, formUrl: string): Promise<RelabelResult> {
  if (!looksLikeQuestionIds(body)) return { body, relabeled: 0, unknown: [] };
  const live = await fetchFormQuestions(formUrl);
  return relabelFormBody(body, { ...CLIENTFORM_QUESTIONS, ...live });
}
