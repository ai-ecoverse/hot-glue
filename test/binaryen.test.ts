import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile } from '../../src/nacre/nacre.js';
import { lower } from '../../src/nacre/binaryen-lower.js';

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

const dir = mkdtempSync(join(tmpdir(), 'nacre-binaryen-'));
const src = (...files: string[]) => files.map((f) => readFileSync(f, 'utf8')).join('\n');

describe.skipIf(!runtime)('binaryen — the alternate lowering', () => {
  it('lowers and optimizes fizzbuzz, which still runs', () => {
    const bin = lower(compile(readFileSync('examples/fizzbuzz.nacre', 'utf8')));
    const f = join(dir, 'fb.wasm');
    writeFileSync(f, bin);
    const got = execFileSync(runtime!, [f], { maxBuffer: 1 << 26 }).toString();
    expect(got).toContain('FizzBuzz');
    expect(got.trim().split('\n')).toHaveLength(100);
  });

  it('the optimized assembler still assembles byte-identically', () => {
    const asWat = compile(src('src/nacre/prelude.nacre', 'src/nacre/as.nacre'));
    const asWatFile = join(dir, 'as.wat');
    const asOptFile = join(dir, 'as.opt.wasm');
    writeFileSync(asWatFile, asWat);
    writeFileSync(asOptFile, lower(asWat));
    const fbWat = compile(readFileSync('examples/fizzbuzz.nacre', 'utf8'));
    const ref = execFileSync(runtime!, [asWatFile], { input: fbWat, maxBuffer: 1 << 26 });
    const opt = execFileSync(runtime!, [asOptFile], { input: fbWat, maxBuffer: 1 << 26 });
    expect(opt.equals(ref)).toBe(true);
  });

  it('lowers the GC module, casts and rec groups intact', () => {
    const bin = lower(compile(readFileSync('examples/gc-ast.nacre', 'utf8')));
    const f = join(dir, 'gc.wasm');
    writeFileSync(f, bin);
    const got = execFileSync(runtime!, ['run', '-W', 'gc,function-references', '--invoke', 'demo', f], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(got.toString().trim()).toBe('15');
  });
});
