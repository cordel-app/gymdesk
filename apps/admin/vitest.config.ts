import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Mirrors tsconfig's "@/*" → "./src/*" so tests can import modules that use the alias
// (e.g. config/navigationGroups.ts). Existing tests use relative imports and are unaffected.
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
});
