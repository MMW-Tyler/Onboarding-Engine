#!/usr/bin/env -S npx tsx
/**
 * Offline replay harness for the Client MMW onboarding form (phase two).
 *
 * Runs every row of an exported form-responses CSV through the SAME
 * deterministic mapping + domain-extraction code the production webhook
 * uses, and reports coverage: which raw labels fall through to the AI
 * fallback, which mapped values look like non-answers ("n/a", "idk", ...),
 * and whether the webhook's run-matching would find a domain to attach to.
 *
 * Usage:
 *   npx tsx scripts/replay-clientform.ts <path-to-csv> [--recent N]
 *
 * Never commit the CSV itself - it contains client PHI-adjacent data (NPI,
 * DEA, licenses, domain/website credentials). This script only prints
 * aggregate counts and field/label names, never sensitive values.
 */
import { readFileSync } from 'node:fs';
import { parse } from 'csv-parse/sync';
import { mapDeterministic } from '../src/profile/canonical.js';
import { extractWebsiteDomain } from '../src/lib/domain.js';
import { SENSITIVE_KEYS } from '../src/redact.js';

const args = process.argv.slice(2);
const csvPath = args[0];
const recentFlagIdx = args.indexOf('--recent');
const recentN = recentFlagIdx >= 0 ? Number(args[recentFlagIdx + 1]) : 20;

if (!csvPath) {
  console.error('Usage: npx tsx scripts/replay-clientform.ts <path-to-csv> [--recent N]');
  process.exit(1);
}

const rawText = readFileSync(csvPath, 'utf8');
const rows: string[][] = parse(rawText, { columns: false, skip_empty_lines: true, relax_column_count: true });
const header = rows[0]!;
const dataRows = rows.slice(1);
const tsIdx = header.findIndex((h) => h.trim() === 'Timestamp');

/** Build a plain {label: value} body exactly as it would arrive over JSON -
 *  duplicate header text collapses to one key, later column wins, since that
 *  is what a JSON object (and therefore a Zapier payload) can represent. */
function toBody(row: string[]): Record<string, string> {
  const body: Record<string, string> = {};
  for (let i = 0; i < header.length; i++) {
    const label = header[i]!;
    const value = (row[i] ?? '').trim();
    if (value === '') continue;
    body[label] = value;
  }
  return body;
}

function parseTs(row: string[]): number {
  if (tsIdx < 0) return 0;
  const t = Date.parse(row[tsIdx] ?? '');
  return Number.isNaN(t) ? 0 : t;
}

const sorted = [...dataRows].sort((a, b) => parseTs(a) - parseTs(b));
const recentRows = sorted.slice(-recentN);

interface Report {
  label: string;
  rowCount: number;
  keyCoverage: Map<string, number>;
  toAILabels: Map<string, number>;
  droppedByReason: Map<string, number>;
  domainFound: number;
  domainMissing: string[]; // raw "website" cell values that failed extraction
}

function runReport(label: string, sample: string[][]): Report {
  const keyCoverage = new Map<string, number>();
  const toAILabels = new Map<string, number>();
  const droppedByReason = new Map<string, number>();
  let domainFound = 0;
  const domainMissing: string[] = [];

  for (const row of sample) {
    const body = toBody(row);
    const domain = extractWebsiteDomain(body);
    if (domain) domainFound++;
    else {
      const websiteLabel = header.find((h) => /website/i.test(h));
      const val = websiteLabel ? body[websiteLabel] : undefined;
      if (val) domainMissing.push(val.replace(/\s+/g, ' ').slice(0, 80));
    }

    const { profile, sensitive, toAI, dropped } = mapDeterministic(body, 'clientform');
    for (const k of Object.keys(profile)) keyCoverage.set(k, (keyCoverage.get(k) ?? 0) + 1);
    for (const k of Object.keys(sensitive)) keyCoverage.set(k, (keyCoverage.get(k) ?? 0) + 1);
    for (const f of toAI) toAILabels.set(f.raw_label, (toAILabels.get(f.raw_label) ?? 0) + 1);
    for (const d of dropped) {
      // Group by reason kind (non_answer / duplicate_of) + canonical key, not the raw label.
      droppedByReason.set(d.reason, (droppedByReason.get(d.reason) ?? 0) + 1);
    }
  }

  return { label, rowCount: sample.length, keyCoverage, toAILabels, droppedByReason, domainFound, domainMissing };
}

function printReport(r: Report): void {
  console.log(`\n=== ${r.label} (${r.rowCount} rows) ===`);

  console.log(`\n-- canonical key coverage (mapped_count / ${r.rowCount}) --`);
  const keys = [...r.keyCoverage.entries()].sort((a, b) => b[1] - a[1]);
  for (const [k, count] of keys) {
    const sens = SENSITIVE_KEYS.has(k) ? ' [sensitive]' : '';
    console.log(`  ${String(count).padStart(3)}  ${k}${sens}`);
  }

  console.log(`\n-- raw labels falling to AI fallback (label: row count) --`);
  if (r.toAILabels.size === 0) {
    console.log('  (none - full deterministic coverage)');
  } else {
    for (const [label, count] of [...r.toAILabels.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(3)}  ${label.replace(/\s+/g, ' ').slice(0, 100)}`);
    }
  }

  console.log(`\n-- dropped values (non-answer scrub / duplicate-key collisions) --`);
  if (r.droppedByReason.size === 0) {
    console.log('  (none)');
  } else {
    for (const [reason, count] of [...r.droppedByReason.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(3)}  ${reason}`);
    }
  }

  console.log(`\n-- domain extraction (webhook run-matching) --`);
  console.log(`  found:   ${r.domainFound} / ${r.rowCount}`);
  console.log(`  missing: ${r.rowCount - r.domainFound} / ${r.rowCount}`);
  if (r.domainMissing.length > 0) {
    console.log(`  sample "website" cell values that failed extraction:`);
    for (const v of r.domainMissing.slice(0, 15)) console.log(`    - ${v}`);
  }
}

console.log(`Loaded ${dataRows.length} total rows from ${csvPath}`);
if (tsIdx >= 0 && recentRows.length > 0) {
  console.log(`Recent-${recentN} date range: ${recentRows[0]![tsIdx]} -> ${recentRows[recentRows.length - 1]![tsIdx]}`);
}

printReport(runReport(`most recent ${recentN}`, recentRows));
printReport(runReport('all rows (legacy context)', dataRows));
