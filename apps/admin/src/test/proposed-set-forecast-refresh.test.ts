// #1867 §6 — the Draft's Billing Event Simulation must follow the Draft. It was
// read once per Draft id, so adding a second line to the same Draft left the
// section showing the first line's schedule (found on dev: API 53.20 €, screen
// 28.00 €). Source-level gate, as the other section-wiring tests here.

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(__dirname, '../app/[locale]/members');
const read = (f: string) => fs.readFileSync(path.join(dir, f), 'utf8');

describe('ProposedSetForecast refresh (#1867 §6)', () => {
  it('re-reads the simulation when the Draft configuration is reloaded', () => {
    const src = read('ProposedSetForecast.tsx');
    expect(src).toMatch(/\[productSetId, reloadKey\]/);
  });

  it('is handed the configuration that every Draft change reloads', () => {
    expect(read('MemberExpandedRow.tsx')).toContain('<ProposedSetForecast productSetId={inFlightSetId} reloadKey={configuration} />');
  });
});
