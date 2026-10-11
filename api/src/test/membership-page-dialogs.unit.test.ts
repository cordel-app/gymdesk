import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #1081 — a member with no live plan but a plan awaiting its first payment
// (#1288) takes the `!membership` branch of My Products. That branch returned
// a page with no consent modal, so *Pay now* set `consentOpen` and nothing
// rendered: no request, no error, no checkout. The two dialogs the page can
// raise are one function, `renderDialogs()`, and every branch that can offer
// the actions that raise them renders it.
//
// Nothing at runtime notices a branch dropping the dialogs — the page still
// renders, the button still looks right — so this gate lives in the API suite
// for #1009's reason: CI runs `npm test` in `api/` only.

const PAGE = join(
  __dirname, '..', '..', '..', 'apps', 'member', 'src', 'app', '[locale]', 'membership', 'page.tsx',
);
const src = readFileSync(PAGE, 'utf-8');

describe('My Products page dialogs (#1081)', () => {
  it('declares the dialogs once, in renderDialogs()', () => {
    expect(src.match(/function renderDialogs\(\)/g)).toHaveLength(1);
    expect(src.match(/\{consentOpen && \(/g)).toHaveLength(1);
    expect(src.match(/\{purchasing && \(/g)).toHaveLength(1);
    const fnStart = src.indexOf('function renderDialogs()');
    expect(src.indexOf('{consentOpen && (')).toBeGreaterThan(fnStart);
    expect(src.indexOf('{purchasing && (')).toBeGreaterThan(fnStart);
  });

  it('renders them from the no-plan branch and from the main return', () => {
    const noPlan = src.indexOf('if (!membership) {');
    expect(noPlan).toBeGreaterThan(-1);
    const mainReturn = src.indexOf('  return (\n    <main', noPlan);
    expect(mainReturn).toBeGreaterThan(noPlan);

    expect(src.slice(noPlan, mainReturn)).toContain('{renderDialogs()}');
    expect(src.slice(mainReturn)).toContain('{renderDialogs()}');
  });
});
