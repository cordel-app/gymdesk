import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(__dirname, '../app/[locale]/calendar');
const read = (f: string) => readFileSync(join(dir, f), 'utf8');

describe('#1892 stage 4 — shared event panel chrome', () => {
  it('both panels render the one header and surface', () => {
    for (const f of ['ClassSessionDetailPanel.tsx', 'EventDetailsPanel.tsx']) {
      const src = read(f);
      expect(src).toContain('EventPanelHeader');
      expect(src).toContain('eventPanelSurfaceStyle');
      expect(src).not.toContain('aria-label="Close"');
    }
  });
});
