#!/usr/bin/env node
/**
 * hotglue — the command line, and the compiler behind it is wasm.
 *
 * Every stage this program runs is a WebAssembly binary shipped in the
 * package: expand.wasm expands, as.wasm assembles, hotglue.wasm drives
 * the two. Node hosts them; nothing here needs a wasmtime, and after
 * the bootstrap that built them, no program in the flow is TypeScript.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { compile, expand, lookupPath } from './drive.js';

const USAGE = `hotglue — expand WebAssembly macros, emit WAT.

Usage:
  hotglue <files.hma...>       Expand files, in order, as one unit
  hotglue -w <files.hma...>    Assemble the result too: a .wasm binary
                               to stdout, from the shipped assembler
  hotglue -O <files.hma...>    Lower through Binaryen instead: an
                               optimized .wasm binary to stdout
  hotglue < file.hma           Or read stdin

Options:
  -w, --wasm                   Emit wasm rather than WAT. No optimizer
                               and no peer dependency: this is as.wasm,
                               which the package carries.
  -O                           Emit optimized wasm rather than WAT.
                               Needs the optional binaryen peer dependency.
  -h, --help                   Print this and stop
  -v, --version                Print the version and stop

An entry file is taken as a path, and if there is no such path, looked
up the way a (use …) is: the entry's own directory, then ./src, then
the sources shipped alongside this program — so the prelude is there
under \`npx @ai-ecoverse/hot-glue\`, with no checkout to find it in.

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

Without it hotglue emits WAT, which wasmtime runs directly, and -w emits a
binary through the assembler the package already ships:

  hotglue -w prog.hma > prog.wasm`,
    );
  }
}

function version(): string {
  const pkg = new URL('../package.json', import.meta.url);
  return JSON.parse(readFileSync(pkg, 'utf8')).version as string;
}

/**
 * The entry files, read and joined as one unit. A path is a path; a
 * bare name that is not one is looked up on the same path a (use …)
 * would be, and the directory it was found in joins the lookup path so
 * that its own imports resolve beside it.
 */
function entries(files: string[]): { source: string; dirs: string[] } {
  const dirs = files.map((f) => dirname(f));
  const texts = files.map((f) => {
    if (existsSync(f)) return readFileSync(f, 'utf8');
    for (const d of lookupPath(dirs)) {
      const p = join(d, f);
      if (existsSync(p)) {
        dirs.push(d);
        return readFileSync(p, 'utf8');
      }
    }
    throw new Error(`${f} not found (looked in ${lookupPath(dirs).join(', ')})`);
  });
  return { source: texts.join('\n'), dirs };
}

// `hotglue big.hma | head` closes the pipe under us, and a compiler that
// dies of a reader's satisfaction is a compiler with a bug.
process.stdout.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EPIPE') process.exit(0);
  throw e;
});

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

  const flag = (...names: string[]) => names.some((n) => args.includes(n));
  const viaBinaryen = flag('-O');
  const viaAssembler = flag('-w', '--wasm');
  const files = args.filter((a) => !a.startsWith('-'));

  // No files and nobody piping: the old behaviour was to block on a stdin
  // that was never coming. Say what the program wants instead.
  if (!files.length && process.stdin.isTTY) {
    console.error(USAGE);
    process.exit(2);
  }

  const { source, dirs } = files.length
    ? entries(files)
    : { source: readFileSync(0, 'utf8'), dirs: [] as string[] };

  if (viaAssembler) {
    process.stdout.write(compile(source, { dirs }).bin);
  } else if (viaBinaryen) {
    const wat = expand(source, { dirs, onWarn: (m) => console.error(`hotglue: ${m}`) });
    const lower = await lowerer();
    process.stdout.write(lower(Buffer.from(wat).toString('utf8')));
  } else {
    process.stdout.write(expand(source, { dirs, onWarn: (m) => console.error(`hotglue: ${m}`) }));
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
