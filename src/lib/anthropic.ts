import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config } from '../config.js';

/**
 * Anthropic client + the two call shapes the engine uses (spec section 14):
 *  - normalizeFields(): structured JSON, claude-haiku-4-5 (Prompts 1-2)
 *  - draft():          draft prose, claude-opus-4-8 (Prompts 3-6, used from M5)
 *
 * Prompt wording lives in versioned /prompts/*.md files so it can iterate
 * without redeploying logic; loadPromptSystem() pulls the System block out.
 */
const NORMALIZE_MODEL = 'claude-haiku-4-5';
const DRAFT_MODEL = 'claude-opus-4-8';

const PROMPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'prompts');

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: config.anthropicApiKey() });
  return client;
}

/** Extract and concatenate the fenced code blocks under "## System" headings. */
export function loadPromptSystem(filename: string): string {
  const md = readFileSync(path.join(PROMPTS_DIR, filename), 'utf8');
  const blocks: string[] = [];
  const headingRe = /^##\s+System.*$/gim;
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(md)) !== null) {
    const after = md.slice(m.index);
    const fence = after.match(/```[a-z]*\n([\s\S]*?)```/i);
    if (fence && fence[1]) blocks.push(fence[1].trim());
  }
  return blocks.join('\n\n');
}

export interface FieldMapping {
  raw_label: string;
  chosen_key: string;
  confidence: number;
  sensitive?: boolean;
}

/**
 * Prompts 1-2: map raw form labels that escaped deterministic matching to
 * canonical keys. The system prompt instructs "JSON only" (an array of
 * {raw_label, chosen_key, confidence, sensitive?}); we parse it defensively.
 * Returns [] if there is nothing to map or the output can't be parsed.
 */
export async function normalizeFields(args: {
  systemText: string;
  canonicalKeys: { key: string; description: string; sensitive?: boolean }[];
  unmappedFields: { raw_label: string; raw_value: string }[];
}): Promise<FieldMapping[]> {
  if (args.unmappedFields.length === 0) return [];
  const user =
    `CANONICAL_KEYS: ${JSON.stringify(args.canonicalKeys)}\n` +
    `UNMAPPED_FIELDS: ${JSON.stringify(args.unmappedFields)}`;

  const res = await anthropic().messages.create({
    model: NORMALIZE_MODEL,
    max_tokens: 4096,
    system: args.systemText,
    messages: [{ role: 'user', content: user }],
  });

  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return parseMappings(text);
}

function parseMappings(text: string): FieldMapping[] {
  const stripped = text.trim().replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim();
  let data: unknown;
  try {
    data = JSON.parse(stripped);
  } catch {
    return [];
  }
  const arr = Array.isArray(data) ? data : Array.isArray((data as any)?.mappings) ? (data as any).mappings : [];
  return (arr as any[])
    .filter((m) => m && typeof m.raw_label === 'string' && typeof m.chosen_key === 'string')
    .map((m) => ({
      raw_label: String(m.raw_label),
      chosen_key: String(m.chosen_key),
      confidence: typeof m.confidence === 'number' ? m.confidence : 0,
      sensitive: m.sensitive === true,
    }));
}

/**
 * Prompts 3-6: draft prose deliverables. Opus 4.8, adaptive thinking off
 * (these are single-shot generations), streamed to avoid timeouts on long output.
 */
export async function draft(args: { systemText: string; userText: string }): Promise<string> {
  const stream = anthropic().messages.stream({
    model: DRAFT_MODEL,
    max_tokens: 16000,
    system: args.systemText,
    messages: [{ role: 'user', content: args.userText }],
  });
  const final = await stream.finalMessage();
  return final.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}
