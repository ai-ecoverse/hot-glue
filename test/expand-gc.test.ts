import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile, loadSource } from '../../src/hotglue/bootstrap.js';

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

const dir = mkdtempSync(join(tmpdir(), 'hotglue-gc-expand-'));
const gcWat = join(dir, 'expand-gc.wat');
const asWat = join(dir, 'as.wat');

const src = (...files: string[]) => loadSource(files);
const GC = ['-W', 'gc,function-references'];
const pipe = (module: string, input: string | Buffer): Buffer =>
  execFileSync(runtime!, ['run', ...GC, '--invoke', 'run', module], { input, maxBuffer: 1 << 26 });

beforeAll(() => {
  writeFileSync(gcWat, compile(src('src/hotglue/expand-gc.hma')));
  writeFileSync(asWat, compile(src('src/hotglue/as.hma')));
});

describe.skipIf(!runtime)('expand-gc.hma — the expander on the GC heap', () => {
  it('matches stage 0 on fizzbuzz, byte for byte', () => {
    const source = readFileSync('examples/fizzbuzz.hma', 'utf8');
    expect(pipe(gcWat, source).toString()).toBe(compile(source));
  });

  it('matches stage 0 on the assembler and the Clojure corpus', () => {
    for (const files of [
      ['src/hotglue/as.hma'],
      ['examples/collatz.hma'],
    ]) {
      const source = src(...files);
      expect(pipe(gcWat, source).toString()).toBe(compile(source));
    }
  });

  it('expands its own source to the text it is running as', () => {
    const source = src('src/hotglue/expand-gc.hma');
    expect(pipe(gcWat, source).toString()).toBe(readFileSync(gcWat, 'utf8'));
  });

  it('runs on the heap it can be assembled from: the GC loop closes', () => {
    // The self-hosted assembler assembles the GC expander into a GC binary.
    const gcWasm = join(dir, 'expand-gc.wasm');
    writeFileSync(gcWasm, execFileSync(runtime!, ['run', '--invoke', 'run', asWat], { input: readFileSync(gcWat), maxBuffer: 1 << 26 }));
    // That binary expands its own source; the assembler (as a binary
    // it assembled itself) reassembles it; the bytes must agree.
    const asWasm = join(dir, 'as.wasm');
    writeFileSync(asWasm, execFileSync(runtime!, ['run', '--invoke', 'run', asWat], { input: readFileSync(asWat), maxBuffer: 1 << 26 }));
    const again = pipe(gcWasm, src('src/hotglue/expand-gc.hma'));
    const rebuilt = execFileSync(runtime!, ['run', '--invoke', 'run', asWasm], { input: again, maxBuffer: 1 << 26 });
    expect(rebuilt.equals(readFileSync(gcWasm))).toBe(true);
  });
});
