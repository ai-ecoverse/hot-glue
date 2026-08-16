import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile } from '../../src/hotglue/bootstrap.js';

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

const dir = mkdtempSync(join(tmpdir(), 'hotglue-tts-'));
const src = (...files: string[]) => files.map((f) => readFileSync(f, 'utf8')).join('\n');
const MIRROR = process.env.KOKORO_MIRROR ?? 'models/kokoro';
const hasModel = existsSync(join(MIRROR, 'onnx', 'model_quantized.onnx'));

const wavWat = () => {
  const p = join(dir, 'wav.wat');
  if (!existsSync(p)) writeFileSync(p, compile(src('src/hotglue/clj.hma', 'examples/wav.hma')));
  return p;
};

describe.skipIf(!runtime)('wav.hma — the Lisp writes the container', () => {
  it('wraps float PCM into a WAV that decodes sample-exact', () => {
    const n = 24000;
    const pcm = Buffer.alloc(n * 4);
    for (let i = 0; i < n; i++) pcm.writeFloatLE(0.5 * Math.sin((2 * Math.PI * 440 * i) / 24000), i * 4);
    const wav = execFileSync(runtime!, [wavWat()], { input: pcm, maxBuffer: 1 << 26 });
    expect(wav.subarray(0, 4).toString()).toBe('RIFF');
    expect(wav.subarray(8, 12).toString()).toBe('WAVE');
    expect(wav.readUInt32LE(24)).toBe(24000); // sample rate
    expect(wav.readUInt16LE(34)).toBe(16); // bit depth
    expect(wav.readUInt32LE(40)).toBe(n * 2); // data size
    expect(wav.length).toBe(44 + n * 2);
    for (const i of [0, 100, 12345]) {
      const want = Math.trunc(32767 * 0.5 * Math.sin((2 * Math.PI * 440 * i) / 24000));
      expect(wav.readInt16LE(44 + i * 2)).toBe(want);
    }
  });

  it('clamps what the synthesizer overshoots', () => {
    const pcm = Buffer.alloc(8);
    pcm.writeFloatLE(3.5, 0);
    pcm.writeFloatLE(-3.5, 4);
    const wav = execFileSync(runtime!, [wavWat()], { input: pcm, maxBuffer: 1 << 26 });
    expect(wav.readInt16LE(44)).toBe(32767);
    expect(wav.readInt16LE(46)).toBe(-32767);
  });
});

// The full voice: Kokoro-82M under onnxruntime-wasm in a headless
// Chromium tab. Needs the local mirror (npm run fetch:kokoro).
describe.skipIf(!runtime || !hasModel)('kokoro — the sandbox speaks', () => {
  it(
    'synthesizes speech with the hot path in wasm, and the Lisp wraps it',
    () => {
      const raw = join(dir, 'voice.f32');
      execFileSync('node', ['scripts/kokoro-voice.mjs'], {
        env: { ...process.env, KOKORO_MIRROR: MIRROR, TEXT: 'The pearl remembers the sand.', OUT: raw },
        stdio: 'pipe',
        timeout: 600000,
      });
      const pcm = readFileSync(raw);
      const seconds = pcm.length / 4 / 24000;
      expect(seconds).toBeGreaterThan(0.8); // it said something
      expect(seconds).toBeLessThan(10); // and knew when to stop
      const wav = execFileSync(runtime!, [wavWat()], { input: pcm, maxBuffer: 1 << 26 });
      expect(wav.subarray(0, 4).toString()).toBe('RIFF');
      expect(wav.readUInt32LE(40)).toBe((pcm.length / 4) * 2);
      let peak = 0;
      for (let i = 44; i < wav.length; i += 2) peak = Math.max(peak, Math.abs(wav.readInt16LE(i)));
      expect(peak).toBeGreaterThan(3000); // audibly a voice, not silence
    },
    600000,
  );
});
