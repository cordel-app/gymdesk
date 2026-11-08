import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// #1764 — a dialog opened from inside a card was clipped by the card's
// overflow/transform, leaving Close unreachable; it must render in document.body.
describe('MemberDialog', () => {
  it('renders through a portal into document.body', () => {
    const src = readFileSync(join(__dirname, '../../../apps/member/src/components/MemberDialog.tsx'), 'utf8');
    expect(src).toMatch(/createPortal\(dialog, document\.body\)/);
  });
});
