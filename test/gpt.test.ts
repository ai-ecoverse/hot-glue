import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile, loadSource } from '../src/bootstrap.js';

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
const weights = existsSync('examples/oyster.npt');

const dir = mkdtempSync(join(tmpdir(), 'hotglue-gpt-'));
const src = (...f: string[]) => loadSource(f);

// stdin blob: [.npt weights][u32 plen][prompt][u32 gen][f32 temp][u32 seed]
function blob(prompt: string, gen: number, temp: number, seed: number): Buffer {
  const w = readFileSync('examples/oyster.npt');
  const p = Buffer.from(prompt, 'utf8');
  const tail = Buffer.alloc(4 + p.length + 12);
  tail.writeUInt32LE(p.length, 0);
  p.copy(tail, 4);
  tail.writeUInt32LE(gen, 4 + p.length);
  tail.writeFloatLE(temp, 8 + p.length);
  tail.writeUInt32LE(seed, 12 + p.length);
  return Buffer.concat([w, tail]);
}

let gptWasm: string;

beforeAll(() => {
  if (!runtime) return;
  const asWat = join(dir, 'as.wat');
  const gptWat = join(dir, 'gpt.wat');
  writeFileSync(asWat, compile(src('src/as.hma')));
  writeFileSync(gptWat, compile(src('examples/gpt.hma')));
  gptWasm = join(dir, 'gpt.wasm');
  writeFileSync(gptWasm, execFileSync(runtime, ['run', '--invoke', 'run', asWat], { input: readFileSync(gptWat), maxBuffer: 1 << 24 }));
});

function speak(prompt: string, gen: number, temp: number, seed: number): Buffer {
  return execFileSync(runtime!, [gptWasm], { input: blob(prompt, gen, temp, seed), maxBuffer: 1 << 24 });
}

describe('a language model, close to the metal', () => {
  it.skipIf(!runtime)('the self-hosted assembler swallows the engine', () => {
    const bin = readFileSync(gptWasm);
    expect(bin.subarray(0, 4)).toEqual(Buffer.from([0, 0x61, 0x73, 0x6d]));
  });

  it.skipIf(!runtime || !weights)('speaks the reference greedy continuation, byte for byte', () => {
    const ref = JSON.parse(readFileSync('examples/oyster.test.json', 'utf8'));
    const out = speak(ref.prompt, 64, 0, 1);
    expect(out.toString('utf8')).toBe(ref.greedy);
  });

  it.skipIf(!runtime || !weights)('logits agree with torch to f32 summation drift', () => {
    const ref = JSON.parse(readFileSync('examples/oyster.test.json', 'utf8'));
    const out = speak(ref.prompt, 0, -1, 1); // a negative temperature asks for raw logits
    expect(out.length).toBe(256 * 4);
    const got = new Float32Array(out.buffer, out.byteOffset, 256);
    let maxDiff = 0;
    let argRef = 0;
    let argGot = 0;
    for (let i = 0; i < 256; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(got[i] - ref.logits[i]));
      if (ref.logits[i] > ref.logits[argRef]) argRef = i;
      if (got[i] > got[argGot]) argGot = i;
    }
    expect(maxDiff).toBeLessThan(0.05);
    expect(argGot).toBe(argRef);
  });

  it.skipIf(!runtime || !weights)('a seed steers the temperature sampler, deterministically', () => {
    const a = speak('The pearl', 32, 0.9, 42);
    const b = speak('The pearl', 32, 0.9, 42);
    const c = speak('The pearl', 32, 0.9, 43);
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
  });
});
