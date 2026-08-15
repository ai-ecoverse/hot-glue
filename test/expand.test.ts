import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile } from '../../src/nacre/nacre.js';

function wasmtime(): string | null {
  for (const bin of ['wasmtime', join(process.env.HOME ?? '', '.local/bin/wasmtime')]) {
    try {
      execFileSync(bin, ['--version'], { stdio: 'pipe' });
      return bin;
    } catch {
      /* keep looking */
    }
  }
  return null;
}
const runtime = wasmtime();

const dir = mkdtempSync(join(tmpdir(), 'nacre-expand-'));
const expandWat = join(dir, 'expand.wat');
const asWat = join(dir, 'as.wat');

const src = (...files: string[]) => files.map((f) => readFileSync(f, 'utf8')).join('\n');
const pipe = (module: string, input: string | Buffer): Buffer =>
  execFileSync(runtime!, [module], { input, maxBuffer: 1 << 26 });

beforeAll(() => {
  writeFileSync(expandWat, compile(src('src/nacre/prelude.nacre', 'src/nacre/expand.nacre')));
  writeFileSync(asWat, compile(src('src/nacre/prelude.nacre', 'src/nacre/as.nacre')));
});

describe.skipIf(!runtime)('expand.nacre — the expander', () => {
  it('matches stage 0 on fizzbuzz, byte for byte', () => {
    const source = readFileSync('examples/fizzbuzz.nacre', 'utf8');
    expect(pipe(expandWat, source).toString()).toBe(compile(source));
  });

  it('matches stage 0 on the assembler, byte for byte', () => {
    const source = src('src/nacre/prelude.nacre', 'src/nacre/as.nacre');
    expect(pipe(expandWat, source).toString()).toBe(compile(source));
  });

  it('matches stage 0 on the GC module, byte for byte', () => {
    const source = readFileSync('examples/gc-ast.nacre', 'utf8');
    expect(pipe(expandWat, source).toString()).toBe(compile(source));
  });

  it('expands its own source to the text it is running as', () => {
    const source = src('src/nacre/prelude.nacre', 'src/nacre/expand.nacre');
    expect(pipe(expandWat, source).toString()).toBe(readFileSync(expandWat, 'utf8'));
  });

  it('closes the loop: binaries rebuild both binaries, byte-identically', () => {
    // Seed: the assembler assembles itself, then assembles the expander.
    const asWasm = join(dir, 'as.wasm');
    writeFileSync(asWasm, pipe(asWat, readFileSync(asWat)));
    const expandWasm = join(dir, 'expand.wasm');
    writeFileSync(expandWasm, pipe(asWasm, readFileSync(expandWat)));

    // From here, no TypeScript and no text parser: source → expand.wasm → as.wasm → binary.
    const fbWat = pipe(expandWasm, readFileSync('examples/fizzbuzz.nacre', 'utf8'));
    const fbWasm = join(dir, 'fb.wasm');
    writeFileSync(fbWasm, pipe(asWasm, fbWat));
    expect(execFileSync(runtime!, [fbWasm], { maxBuffer: 1 << 26 }).toString()).toContain('FizzBuzz');

    // The ouroboros, both heads: each tool rebuilds itself through the other.
    const expandWat2 = pipe(expandWasm, src('src/nacre/prelude.nacre', 'src/nacre/expand.nacre'));
    const expandWasm2 = pipe(asWasm, expandWat2);
    expect(expandWasm2.equals(readFileSync(expandWasm))).toBe(true);
    const asWat2 = pipe(expandWasm, src('src/nacre/prelude.nacre', 'src/nacre/as.nacre'));
    const asWasm2 = pipe(asWasm, asWat2);
    expect(asWasm2.equals(readFileSync(asWasm))).toBe(true);
  });
});
