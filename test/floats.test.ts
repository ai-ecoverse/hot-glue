import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile, loadSource } from '../../src/hotglue/bootstrap.js';

function probe(bins: string[], flag: string): string | null {
  for (const bin of bins) {
    try {
      execFileSync(bin, [flag], { stdio: 'pipe' });
      return bin;
    } catch {
      /* keep looking */
    }
  }
  return null;
}
const runtime = probe(['wasmtime', join(process.env.HOME ?? '', '.local/bin/wasmtime')], '--version');

const dir = mkdtempSync(join(tmpdir(), 'hotglue-floats-'));
const src = (...files: string[]) => loadSource(files);
const asWat = join(dir, 'as.wat');
const GC = ['-W', 'gc,function-references'];

const CONSTANTS = `(module
  (type $t (func (result f64)))
  (func (export "pi") (type $t) (result f64) (f64.const 3.141592653589793))
  (func (export "circle") (type $t) (result f64)
    (f64.mul (f64.const 3.141592653589793) (f64.mul (f64.const 2.5) (f64.const 2.5))))
  (func (export "root2") (type $t) (result f64) (f64.sqrt (f64.const 2)))
  (func (export "milli") (type $t) (result f64) (f64.const 1.5e-3))
  (func (export "avogadro") (type $t) (result f64) (f64.const 6.02214076e23)))`;

const invoke = (wasm: string, name: string) =>
  parseFloat(
    execFileSync(runtime!, ['run', '--invoke', name, wasm], { stdio: ['pipe', 'pipe', 'pipe'] }).toString(),
  );

beforeAll(() => {
  writeFileSync(asWat, compile(src('src/hotglue/as.hma')));
});

describe.skipIf(!runtime)('floating point — the missing vowels', () => {
  it('assembles f64 constants within an ulp or two of the truth', () => {
    const wasm = join(dir, 'constants.wasm');
    writeFileSync(wasm, execFileSync(runtime!, [asWat], { input: compile(CONSTANTS), maxBuffer: 1 << 26 }));
    const close = (got: number, want: number) =>
      expect(Math.abs(got - want)).toBeLessThanOrEqual(Math.abs(want) * 1e-14);
    close(invoke(wasm, 'pi'), Math.PI);
    close(invoke(wasm, 'circle'), Math.PI * 2.5 * 2.5);
    close(invoke(wasm, 'root2'), Math.SQRT2);
    close(invoke(wasm, 'milli'), 1.5e-3);
    close(invoke(wasm, 'avogadro'), 6.02214076e23);
  });

  it('float literals travel through all three expanders as the same bytes', () => {
    const source = src('examples/deepzoom.hma');
    const want = compile(source);
    const expandWat = join(dir, 'expand.wat');
    writeFileSync(expandWat, compile(src('src/hotglue/expand.hma')));
    expect(execFileSync(runtime!, [expandWat], { input: source, maxBuffer: 1 << 26 }).toString()).toBe(want);
    const gcWat = join(dir, 'expand-gc.wat');
    writeFileSync(gcWat, compile(src('src/hotglue/expand-gc.hma')));
    expect(
      execFileSync(runtime!, ['run', ...GC, gcWat], { input: source, maxBuffer: 1 << 26 }).toString(),
    ).toBe(want);
  });

  it('deepzoom: the hotglue-assembled f64 binary dives a million deep', () => {
    const wat = compile(src('examples/deepzoom.hma'));
    const wasm = join(dir, 'deepzoom.wasm');
    writeFileSync(wasm, execFileSync(runtime!, [asWat], { input: wat, maxBuffer: 1 << 26 }));
    const y4m = execFileSync(runtime!, [wasm], { maxBuffer: 1 << 27 });
    const HEADER = 'YUV4MPEG2 W256 H256 F30:1 Ip A1:1 C444\n';
    const FRAME = 6 + 3 * 65536;
    expect(y4m.subarray(0, HEADER.length).toString()).toBe(HEADER);
    expect(y4m.length).toBe(HEADER.length + 200 * FRAME);
    const luma = (n: number) => y4m.subarray(HEADER.length + n * FRAME + 6, HEADER.length + n * FRAME + 6 + 65536);
    expect(luma(0).equals(luma(190))).toBe(false); // still zooming at frame 190
  }, 120000);
});
