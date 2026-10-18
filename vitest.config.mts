import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // The web app's "@/…" imports (apps/web/tsconfig.json paths), for tests of editor modules.
    alias: { '@': fileURLToPath(new URL('./apps/web/src', import.meta.url)) },
  },
  // apps/web's tsconfig preserves JSX for Next; tests of components compile it here.
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'scripts/test/**/*.test.ts', 'apps/exporter/test/**/*.test.ts', 'apps/web/test/**/*.test.{ts,tsx}'],
    environment: 'node',
    testTimeout: 60_000,
  },
});
