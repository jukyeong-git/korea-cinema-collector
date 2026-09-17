import { buildSync } from 'esbuild';
import { mkdirSync } from 'node:fs';
mkdirSync('dist', { recursive: true });
buildSync({ entryPoints: ['src/platform/aws/receiver.ts'], bundle: true, platform: 'node', target: 'node22',
  format: 'esm', outfile: 'dist/handler.mjs',
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' } });
