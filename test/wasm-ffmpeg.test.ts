import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
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

const dir = mkdtempSync(join(tmpdir(), 'hotglue-wasmpeg-'));
const src = (...files: string[]) => files.map((f) => readFileSync(f, 'utf8')).join('\n');

// The Emscripten core of ffmpeg.wasm predates Node's global fetch and
// misdetects its environment when it sees one. Take it away for the
// duration; every worker file is isolated, and we put it back anyway.
const realFetch = globalThis.fetch;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ffmpeg: any;

beforeAll(async () => {
  if (!runtime) return;
  // @ts-expect-error deliberate: see comment above
  delete globalThis.fetch;
  const { createFFmpeg } = await import('@ffmpeg/ffmpeg');
  const require = createRequire(process.cwd() + '/');
  ffmpeg = createFFmpeg({ log: false, corePath: require.resolve('@ffmpeg/core/dist/ffmpeg-core.js') });
  await ffmpeg.load();
  // both video sources, rendered by wasmtime from hotglue-built modules
  for (const [name, files] of [
    ['a.y4m', ['src/hotglue/clj.hma', 'examples/mandelzoom.hma']],
    ['b.y4m', ['src/hotglue/clj.hma', 'examples/deepzoom.hma']],
  ] as const) {
    const wat = join(dir, name + '.wat');
    writeFileSync(wat, compile(src(...files)));
    ffmpeg.FS('writeFile', name, execFileSync(runtime, [wat], { maxBuffer: 1 << 27 }));
  }
}, 240000);

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe.skipIf(!runtime)('ffmpeg compiled to wasm — no native code all the way down', () => {
  it(
    'transcodes the Lisp stream to H.264 inside the sandbox',
    async () => {
      await ffmpeg.run('-i', 'b.y4m', '-frames:v', '45', '-pix_fmt', 'yuv420p', 'out.mp4');
      const mp4: Uint8Array = ffmpeg.FS('readFile', 'out.mp4');
      expect(Buffer.from(mp4.subarray(4, 8)).toString()).toBe('ftyp');
      expect(mp4.length).toBeGreaterThan(10000);
    },
    240000,
  );

  it(
    'composites two Lisp streams, wasm end to end',
    async () => {
      await ffmpeg.run(
        '-i', 'a.y4m', '-i', 'b.y4m',
        '-filter_complex', '[0:v][1:v]hstack',
        '-frames:v', '30', '-pix_fmt', 'yuv420p', 'duet.mp4',
      );
      const mp4: Uint8Array = ffmpeg.FS('readFile', 'duet.mp4');
      expect(Buffer.from(mp4.subarray(4, 8)).toString()).toBe('ftyp');
      expect(mp4.length).toBeGreaterThan(10000);
    },
    240000,
  );
});
