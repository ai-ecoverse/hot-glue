#!/usr/bin/env npx tsx
/**
 * nacre — expand WebAssembly macros, emit WAT.
 *
 * Usage:
 *   nacre <files.nacre...>   Expand files, in order, as one unit
 *   nacre < file.nacre       Or read stdin
 *
 * The output is plain WAT. Feed it to wasmtime.
 */
import { readFileSync } from 'node:fs';
import { compile } from './nacre.js';

try {
  const files = process.argv.slice(2);
  const src = files.length ? files.map((f) => readFileSync(f, 'utf8')).join('\n') : readFileSync(0, 'utf8');
  process.stdout.write(compile(src));
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
