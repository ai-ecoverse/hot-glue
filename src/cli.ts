#!/usr/bin/env node
/**
 * hotglue — expand WebAssembly macros, emit WAT.
 *
 * Without -O the output is plain WAT. Feed it to wasmtime, or to the
 * self-hosted assembler (as.hma).
 */
import { readFileSync } from 'node:fs';
import { compile, loadSource, lookupPath, resolveUses } from './bootstrap.js';

const USAGE = `hotglue — expand WebAssembly macros, emit WAT.

Usage:
  hotglue <files.hma...>       Expand files, in order, as one unit
  hotglue -O <files.hma...>    Lower through Binaryen instead: emit an
                               optimized .wasm binary to stdout
  hotglue < file.hma           Or read stdin

Options:
  -O                           Emit optimized wasm rather than WAT.
                               Needs the optional binaryen peer dependency.
  -h, --help                   Print this and stop
  -v, --version                Print the version and stop

A (use name.hma) is resolved against the entry file's own directory, then
./src, then the sources shipped alongside this program — so the prelude is
there under \`npx @ai-ecoverse/hot-glue\`, with no checkout to find it in.

  npx @ai-ecoverse/hot-glue examples/fizzbuzz.hma > fizzbuzz.wat
  wasmtime fizzbuzz.wat`;

// -O lowers through Binaryen, which this package does not install for
// anyone: it is an optional peer dependency, and a 100 MB one, for a flag
// most callers never pass. When it is absent, say that — the resolver's
// own words are about a file path nobody chose.
async function lowerer(): Promise<(wat: string) => Uint8Array> {
  try {
    return (await import('./binaryen-lower.js')).lower;
  } catch (e) {
    const absent =
      e instanceof Error &&
      (e as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND' &&
      e.message.includes("'binaryen'");
    if (!absent) throw e; // binaryen is here and had something else to say
    throw new Error(
      `-O needs binaryen, which is an optional peer dependency and is not installed:

  npm install binaryen

Without it hotglue emits WAT, which wasmtime runs directly, and which the
self-hosted assembler turns into a binary:

  hotglue prog.hma > prog.wat && wasmtime prog.wat`
    );
  }
}

function version(): string {
  const pkg = new URL('../package.json', import.meta.url);
  return JSON.parse(readFileSync(pkg, 'utf8')).version as string;
}

try {
  const args = process.argv.slice(2);

  if (args.includes('-h') || args.includes('--help')) {
    console.log(USAGE);
    process.exit(0);
  }
  if (args.includes('-v') || args.includes('--version')) {
    console.log(version());
    process.exit(0);
  }

  const viaBinaryen = args[0] === '-O';
  const files = viaBinaryen ? args.slice(1) : args;

  // No files and nobody piping: the old behaviour was to block on a stdin
  // that was never coming. Say what the program wants instead.
  if (!files.length && process.stdin.isTTY) {
    console.error(USAGE);
    process.exit(2);
  }

  const src = files.length
    ? loadSource(files)
    : resolveUses(readFileSync(0, 'utf8'), lookupPath());
  const wat = compile(src);
  if (viaBinaryen) {
    const lower = await lowerer();
    process.stdout.write(Buffer.from(lower(wat)));
  } else {
    process.stdout.write(wat);
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
