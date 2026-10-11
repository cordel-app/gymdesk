import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

// A `<style>` element's text child is escaped by React's server renderer
// (`'` → `&#x27;`, `"` → `&quot;`, `>` → `&gt;`) and not decoded by the browser,
// so a stylesheet with a quote or a child combinator mismatched on hydration
// (React #425/#418/#423) on every page load of the Members App. The sheet goes
// through `InlineStyle`, which sets the text untouched. In the API suite for
// #1009's reason: CI runs `npm test` in `api/` only.

const roots = ['member', 'admin'].map((app) => join(__dirname, '..', '..', '..', 'apps', app, 'src'));
const root = roots[0];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === 'test' ? [] : sources(full);
    return /\.(tsx|ts)$/.test(name) ? [full] : [];
  });
}

describe('Members App and Admin inline stylesheets', () => {
  for (const dir of roots) {
    const app = dir.split('/').slice(-2)[0];

    it(`${app}: renders no <style> with a text child`, () => {
      const offenders = sources(dir).filter((file) => {
        if (file.endsWith('InlineStyle.tsx')) return false;
        const code = readFileSync(file, 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        return /<style[^>]*>\s*\{/.test(code);
      });
      expect(offenders.map((f) => f.slice(dir.length))).toEqual([]);
    });

    it(`${app}: InlineStyle hands the text over unescaped`, () => {
      const src = readFileSync(join(dir, 'components', 'InlineStyle.tsx'), 'utf-8');
      expect(src).toContain('dangerouslySetInnerHTML={{ __html: css }}');
    });
  }
});
