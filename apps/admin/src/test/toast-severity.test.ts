import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join, relative } from 'path';

// Regression test for #667 — informational toasts must not be styled as errors.
//
// `toast(message, type?)` defaults `type` to 'error', because most call sites
// report a failed request. The cost of that default is that a confirmation which
// forgets the second argument is rendered with the red border and the ✕ icon —
// which is exactly what "Diagnostics copied to clipboard." did.
//
// This repo has no component-test infra for apps/admin (see docs/architecture.md's
// TL;DR), so — like sellable-items-column-alignment.test.ts (#637) — this scans
// the sources. It pins the three call sites the ticket fixes, and then sweeps
// every `toast(` call in the admin app so a future confirmation cannot regress
// into the error variant by omission.

const SRC_DIR = join(__dirname, '..');
const TOAST_COMPONENT = join(SRC_DIR, 'components', 'Toast.tsx');

/**
 * Source files that call `toast(` — the component itself and the tests aside.
 *
 * `withFileTypes` rather than a `statSync` on the joined path: the directory
 * entry already carries its type, so there is no check-then-read of the same
 * path to go stale in between (CodeQL js/file-system-race).
 */
function appSources(): { file: string; src: string }[] {
  const out: { file: string; src: string }[] = [];
  (function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'test' && entry.name !== 'node_modules') walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!/\.tsx?$/.test(entry.name)) continue;
      if (full === TOAST_COMPONENT) continue;
      out.push({ file: relative(SRC_DIR, full), src: readFileSync(full, 'utf-8') });
    }
  })(SRC_DIR);
  return out;
}

interface ToastCall {
  file: string;
  /** 1-indexed line of the `toast(`. */
  line: number;
  /** Source text of the first argument (the message). */
  message: string;
  /** Source text of the second argument (the variant), or null when omitted. */
  variant: string | null;
}

/**
 * Splits a call's argument list on the commas that are at depth 0 and outside a
 * string, so `toast(t('k', { n: 1 }), 'success')` yields two arguments rather
 * than three. Returns the arguments and the index just past the closing paren.
 */
function readCallArgs(src: string, openParen: number): { args: string[]; end: number } {
  const args: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = openParen + 1;
  let i = start;

  for (; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; continue; }
    if (ch === ')' && depth === 0) break;
    if (ch === ')' || ch === ']' || ch === '}') { depth--; continue; }
    if (ch === ',' && depth === 0) {
      args.push(src.slice(start, i).trim());
      start = i + 1;
    }
  }
  const tail = src.slice(start, i).trim();
  if (tail.length > 0) args.push(tail);
  return { args, end: i + 1 };
}

function toastCalls({ file, src }: { file: string; src: string }): ToastCall[] {
  const calls: ToastCall[] = [];
  const re = /\btoast\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const openParen = src.indexOf('(', m.index);
    const { args, end } = readCallArgs(src, openParen);
    if (args.length === 0) continue;
    calls.push({
      file,
      line: src.slice(0, m.index).split('\n').length,
      message: args[0],
      variant: args[1] ?? null,
    });
    re.lastIndex = end;
  }
  return calls;
}

/** A message whose own wording says the operation failed. */
const FAILURE = /error|fail/i;
/** A message whose own wording says the operation succeeded. */
const CONFIRMATION = /success|copied|_saved\b|_ok\b/i;

const NON_ERROR_VARIANTS = ["'success'", "'info'"];

const calls = appSources().flatMap(toastCalls);

function at(c: ToastCall) {
  return `${c.file}:${c.line} — toast(${c.message}${c.variant ? `, ${c.variant}` : ''})`;
}

describe('Toast severity (#667)', () => {
  it('found the toast call sites to check', () => {
    expect(calls.length).toBeGreaterThan(100);
  });

  it('keeps a distinct, non-red variant for success and info', () => {
    const src = readFileSync(TOAST_COMPONENT, 'utf-8');
    // The three variants and their colours: only `error` may be red.
    expect(src).toMatch(/error:\s*\{\s*border:\s*'#e74c3c'/);
    expect(src).toMatch(/success:\s*\{\s*border:\s*'#27ae60'/);
    expect(src).toMatch(/info:\s*\{\s*border:\s*'#3498db'/);
    expect(src).toContain("export type ToastType = 'error' | 'success' | 'info';");
    // The error icon must not be reachable from a non-error variant.
    expect(src.match(/icon: '✕'/g) ?? []).toHaveLength(1);
  });

  // The call sites named by the ticket and found alongside it.
  it.each([
    ['app/[locale]/system/gyms/page.tsx', "t('storage_report_copied')"],
    ['app/[locale]/payments/billing-events/page.tsx', "t('billing_events_page.manual_success')"],
    ['app/[locale]/payments/billing-events/page.tsx', "t('billing_events_page.retry_success')"],
  ])('%s shows %s as a confirmation, not an error', (file, message) => {
    const match = calls.find((c) => c.file === file && c.message === message);
    expect(match, `no toast(${message}) left in ${file}`).toBeDefined();
    expect(match!.variant, `${at(match!)} is still styled as an error`).toBe("'success'");
  });

  it('never styles a confirmation as an error', () => {
    const wrong = calls.filter(
      (c) => CONFIRMATION.test(c.message) && !FAILURE.test(c.message)
        && !NON_ERROR_VARIANTS.includes(c.variant ?? ''),
    );
    expect(wrong.map(at), 'confirmations must pass \'success\' or \'info\'').toEqual([]);
  });

  it('keeps the error variant for messages that report a failure', () => {
    const wrong = calls.filter(
      (c) => FAILURE.test(c.message) && !CONFIRMATION.test(c.message)
        && NON_ERROR_VARIANTS.includes(c.variant ?? ''),
    );
    expect(wrong.map(at), 'failures must keep the error styling').toEqual([]);
  });

  it('passes only a known variant', () => {
    const wrong = calls.filter(
      (c) => c.variant !== null
        && /^'[^']*'$/.test(c.variant)
        && !["'error'", ...NON_ERROR_VARIANTS].includes(c.variant),
    );
    expect(wrong.map(at), 'unknown ToastType literal').toEqual([]);
  });
});
