#!/usr/bin/env node
// Bundles a Node entry point (API or worker) with esbuild. Workspace packages are bundled
// (they ship TypeScript source); third-party packages stay external and load from node_modules.
//   node scripts/build-node.mjs src/server.ts dist/server.js
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const [entry, outfile] = process.argv.slice(2);
if (!entry || !outfile) {
  console.error('usage: build-node.mjs <entry> <outfile>');
  process.exit(1);
}
const pkg = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8'));
const external = Object.keys(pkg.dependencies ?? {}).filter((d) => !d.startsWith('@clipforge/'));
// Packages pulled in through workspace packages.
external.push('pg', 'pg-boss', 'pino', 'zod', '@anthropic-ai/sdk', '@supabase/supabase-js', 'jose', 'react', 'react-dom', 'remotion', '@remotion/*', '@fontsource/*');

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  external,
  logLevel: 'info',
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
