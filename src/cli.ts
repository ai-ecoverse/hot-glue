#!/usr/bin/env npx tsx
/**
 * hotglue — expand WebAssembly macros, emit WAT.
 *
 * Usage:
 *   hotglue <files.hma...>       Expand files, in order, as one unit
 *   hotglue -O <files.hma...>    Lower through Binaryen instead: emit
 *                                an optimized .wasm binary to stdout
 *   hotglue < file.hma           Or read stdin
 *
 * Without -O the output is plain WAT. Feed it to wasmtime, or to the
 * self-hosted assembler (as.hma).
 */
import { readFileSync } from 'node:fs';
import { compile } from './bootstrap.js';

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
