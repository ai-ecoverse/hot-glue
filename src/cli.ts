#!/usr/bin/env npx tsx
/**
 * nacre — expand WebAssembly macros, emit WAT.
 *
 * Usage:
 *   nacre <file.nacre>       Expand a file to stdout
 *   nacre < file.nacre       Or read stdin
 *
 * The output is plain WAT. Feed it to wasmtime.
 */
import { readFileSync } from 'node:fs';
import { compile } from './nacre.js';

try {
  process.stdout.write(compile(readFileSync(process.argv[2] ?? 0, 'utf8')));
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
