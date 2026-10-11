import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// The Members App's `apiFetch` must keep its identity between renders: the
// Calendar passes it to FullCalendar's `events` source and the Goals page puts it
// in effect dependencies, so a function recreated every render re-ran both
// (168 `/me/schedule` requests in two seconds). In the API suite for #1009's
// reason: CI runs `npm test` in `api/` only.

const src = readFileSync(join(__dirname, '..', '..', '..', 'apps', 'member', 'src', 'lib', 'apiClient.ts'), 'utf-8')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/\/\*[\s\S]*?\*\//g, '');

describe('useApiClient referential stability', () => {
  it('memoizes apiFetch and uploadFetch on the tenant headers only', () => {
    expect(src).toMatch(/const apiFetch = useCallback\(/);
    expect(src).toMatch(/const uploadFetch = useCallback\(/);
    const deps = src.match(/\}, \[([^\]]*)\]\);/g) ?? [];
    expect(deps).toHaveLength(2);
    for (const d of deps) {
      expect(d).toContain('gymId');
      expect(d).toContain('activeCenterId');
      expect(d).toContain('locale');
      expect(d).not.toContain('getToken');
    }
  });

  it('reads the token function through a ref', () => {
    expect(src).toContain('getTokenRef.current()');
    expect(src).not.toMatch(/await getToken\(\)/);
  });
});
