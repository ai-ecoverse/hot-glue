#!/usr/bin/env npx tsx
/**
 * nacre — expand WebAssembly macros, emit WAT.
 *
 * Usage:
 *   nacre <files.nacre...>       Expand files, in order, as one unit
 *   nacre -O <files.nacre...>    Lower through Binaryen instead: emit
 *                                an optimized .wasm binary to stdout
 *   nacre < file.nacre           Or read stdin
 *
 * Without -O the output is plain WAT. Feed it to wasmtime, or to the
 * self-hosted assembler (as.nacre).
 */
import { readFileSync } from 'node:fs';
import { compile } from './nacre.js';

try {
  const args = process.argv.slice(2);
  const viaBinaryen = args[0] === '-O';
  const files = viaBinaryen ? args.slice(1) : args;
  const src = files.length ? files.map((f) => readFileSync(f, 'utf8')).join('\n') : readFileSync(0, 'utf8');
  const wat = compile(src);
  if (viaBinaryen) {
    const { lower } = await import('./binaryen-lower.js');
    process.stdout.write(Buffer.from(lower(wat)));
  } else {
    process.stdout.write(wat);
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
