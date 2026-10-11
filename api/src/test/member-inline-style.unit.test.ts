import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

// A `<style>` element's text child is escaped by React's server renderer
// (`'` → `&#x27;`, `"` → `&quot;`, `>` → `&gt;`) and not decoded by the browser,
// so a stylesheet with a quote or a child combinator mismatched on hydration
// (React #425/#418/#423) on every page load of the Members App. The sheet goes
// through `InlineStyle`, which sets the text untouched. In the API suite for
// #1009's reason: CI runs `npm test` in `api/` only.

const root = join(__dirname, '..', '..', '..', 'apps', 'member', 'src');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === 'test' ? [] : sources(full);
    return /\.(tsx|ts)$/.test(name) ? [full] : [];
  });
}

describe('Members App inline stylesheets', () => {
  it('renders no <style> with a text child', () => {
    const offenders = sources(root).filter((file) => {
      if (file.endsWith('InlineStyle.tsx')) return false;
      const code = readFileSync(file, 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      return /<style[^>]*>\s*\{/.test(code);
    });
    expect(offenders.map((f) => f.slice(root.length))).toEqual([]);
  });

  it('InlineStyle hands the text over unescaped', () => {
    const src = readFileSync(join(root, 'components', 'InlineStyle.tsx'), 'utf-8');
    expect(src).toContain('dangerouslySetInnerHTML={{ __html: css }}');
  });
});
