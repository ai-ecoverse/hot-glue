import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
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

const dir = mkdtempSync(join(tmpdir(), 'hotglue-interop-'));
const src = (...files: string[]) => loadSource(files);

// MurmurHash3's finalizer, the reference the Rust module must match
const fmix32 = (h: number): number => {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
};

const MSG = 'The pearl remembers the sand.';
const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0');

const PRELOADS = [
  '--preload', 'c=examples/native/crc32.wasm',
  '--preload', 'rust=examples/native/fmix.wasm',
];

const interopWat = join(dir, 'interop.wat');
const mandelWat = join(dir, 'mandelbrot.wat');
const asWat = join(dir, 'as.wat');

beforeAll(() => {
  writeFileSync(interopWat, compile(src('examples/interop.hma')));
  writeFileSync(mandelWat, compile(src('examples/mandelbrot.hma')));
  writeFileSync(asWat, compile(src('src/hotglue/as.hma')));
});

describe.skipIf(!runtime)('the binary wilderness', () => {
  it('hot glue calls C calls back: crc32 agrees with node:zlib', () => {
    const got = execFileSync(runtime!, ['run', ...PRELOADS, interopWat], { maxBuffer: 1 << 26 }).toString();
    expect(got).toContain(`crc32 by C:    ${hex(crc32(Buffer.from(MSG)))}`);
  });

  it('and Rust mixes the result: fmix32 agrees with the reference', () => {
    const got = execFileSync(runtime!, ['run', ...PRELOADS, interopWat], { maxBuffer: 1 << 26 }).toString();
    expect(got).toContain(`mixed by Rust: ${hex(fmix32(crc32(Buffer.from(MSG))))}`);
  });

  it('the hotglue-assembled binary sits in the same food chain', () => {
    const bin = execFileSync(runtime!, [asWat], { input: readFileSync(interopWat), maxBuffer: 1 << 26 });
    const wasm = join(dir, 'interop.wasm');
    writeFileSync(wasm, bin);
    const got = execFileSync(runtime!, ['run', ...PRELOADS, wasm], { maxBuffer: 1 << 26 }).toString();
    expect(got).toContain(hex(fmix32(crc32(Buffer.from(MSG)))));
  });

  it('mandelbrot: a Lisp renders the set in i32 and prints a PPM', () => {
    const ppm = execFileSync(runtime!, [mandelWat], { maxBuffer: 1 << 26 });
    expect(ppm.subarray(0, 15).toString()).toBe('P6\n256 256\n255\n');
    expect(ppm.length).toBe(15 + 256 * 256 * 3);
    const px = (x: number, y: number) => ppm.subarray(15 + (y * 256 + x) * 3, 18 + (y * 256 + x) * 3);
    expect([...px(128, 128)]).toEqual([0, 0, 0]); // the center is in the set
    expect(px(0, 0)[0]).toBeGreaterThan(0); // the corner escapes at once
    let black = 0;
    for (let i = 15; i < ppm.length; i += 3) if (!ppm[i] && !ppm[i + 1] && !ppm[i + 2]) black++;
    expect(black).toBeGreaterThan(8000); // the set holds its ground
    expect(black).toBeLessThan(20000); // but does not flood the frame
  });

  it('the assembled mandelbrot paints the same picture', () => {
    const bin = execFileSync(runtime!, [asWat], { input: readFileSync(mandelWat), maxBuffer: 1 << 26 });
    const wasm = join(dir, 'mandelbrot.wasm');
    writeFileSync(wasm, bin);
    const a = execFileSync(runtime!, [mandelWat], { maxBuffer: 1 << 26 });
    const b = execFileSync(runtime!, [wasm], { maxBuffer: 1 << 26 });
    expect(a.equals(b)).toBe(true);
  });
});
