import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #1297 — My Training: themed Mark done, Done! chip, inline exercise logs.
const page = readFileSync(join(__dirname, '..', 'app', '[locale]', 'training', 'page.tsx'), 'utf-8');

describe('My Training inline logs (#1297)', () => {
  it('does not hardcode the Mark done colour', () => {
    expect(page).not.toMatch(/blockDoneBtn:[^\n]*statusSuccess/);
  });
  it('hides Mark done once a block is done and shows the Done! chip', () => {
    expect(page).toContain('!doneBlocks.has(block.id)');
    expect(page).toContain("t('training.done')");
  });
  it('has no Save button and reads the latest 5 logs of the exercise', () => {
    expect(page).not.toContain('training.save_log');
    expect(page).toContain('limit=${INLINE_LOG_LIMIT}');
  });
});
