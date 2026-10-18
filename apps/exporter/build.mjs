// Bundles the exporter into dist/main.mjs, so the installed app runs it with plain node - no tsx
// and no TypeScript at run time. dist/ sits next to src/, so paths built from import.meta.url
// (the repo root, assets/fonts) stay the same. @napi-rs/canvas is native and stays a package.
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

await build({
  entryPoints: [fileURLToPath(new URL('./src/main.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('./dist/main.mjs', import.meta.url)),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['@napi-rs/canvas'],
  // Bundled CommonJS code may still call require().
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  logLevel: 'warning',
});
