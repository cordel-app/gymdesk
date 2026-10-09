import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { buildThemeSnapshot, isThemeVariable, THEME_SNAPSHOT_SCRIPT } from '../lib/themeSnapshot';

// #1299 — a hard reload paints the last applied theme before React runs.
const SRC = join(__dirname, '..');
const read = (...p: string[]) => readFileSync(join(SRC, ...p), 'utf8');

describe('theme snapshot (#1299)', () => {
  it('keeps only the variables applyTokens owns', () => {
    expect(isThemeVariable('--gd-app-bg')).toBe(true);
    expect(isThemeVariable('--brand')).toBe(true);
    expect(isThemeVariable('--other')).toBe(false);
    const names = ['--gd-app-bg', 'color', '--brand'];
    const values: Record<string, string> = { '--gd-app-bg': '#fff', color: 'red', '--brand': '#123456' };
    const style = { length: 3, item: (i: number) => names[i], getPropertyValue: (n: string) => values[n] } as unknown as CSSStyleDeclaration;
    expect(buildThemeSnapshot('g1', style)).toEqual({ gymId: 'g1', vars: { '--gd-app-bg': '#fff', '--brand': '#123456' } });
  });

  it('the head script only replays a snapshot of the selected gym', () => {
    const store: Record<string, string> = {
      'gd-theme-snapshot': JSON.stringify({ gymId: 'g1', vars: { '--gd-app-bg': '#abc', '--evil': 'x' } }),
      activeGymId: 'g1',
    };
    const set: Record<string, string> = {};
    const run = (gym: string) => {
      store.activeGymId = gym;
      for (const k of Object.keys(set)) delete set[k];
      new Function('localStorage', 'document', THEME_SNAPSHOT_SCRIPT)(
        { getItem: (k: string) => store[k] ?? null },
        { documentElement: { style: { setProperty: (k: string, v: string) => { set[k] = v; } } } },
      );
    };
    run('g1');
    expect(set).toEqual({ '--gd-app-bg': '#abc' });
    run('g2');
    expect(set).toEqual({});
  });

  it('the provider does not repaint the default while gyms load, and the layout injects the script', () => {
    expect(read('components', 'ThemeProvider.tsx')).toMatch(/if \(loading && !activeGym\) return;/);
    expect(read('app', '[locale]', 'layout.tsx')).toContain('THEME_SNAPSHOT_SCRIPT');
  });
});
