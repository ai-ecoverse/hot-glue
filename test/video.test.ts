import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile } from '../../src/nacre/nacre.js';

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
const ffmpeg = probe(['ffmpeg'], '-version');

const dir = mkdtempSync(join(tmpdir(), 'nacre-video-'));
const src = (...files: string[]) => files.map((f) => readFileSync(f, 'utf8')).join('\n');
const zoomWat = join(dir, 'mandelzoom.wat');
const y4mFile = join(dir, 'zoom.y4m');

const HEADER = 'YUV4MPEG2 W256 H256 F30:1 Ip A1:1 C444\n';
const FRAME = 6 + 3 * 65536;

beforeAll(() => {
  writeFileSync(zoomWat, compile(src('src/nacre/clj.nacre', 'examples/mandelzoom.nacre')));
  if (runtime) writeFileSync(y4mFile, execFileSync(runtime, [zoomWat], { maxBuffer: 1 << 26 }));
}, 120000);

describe.skipIf(!runtime)('mandelzoom — a Lisp is a video source', () => {
  it('emits a well-formed YUV4MPEG2 stream: 150 frames, three planes each', () => {
    const y4m = readFileSync(y4mFile);
    expect(y4m.subarray(0, HEADER.length).toString()).toBe(HEADER);
    expect(y4m.length).toBe(HEADER.length + 150 * FRAME);
    for (const n of [0, 74, 149])
      expect(y4m.subarray(HEADER.length + n * FRAME, HEADER.length + n * FRAME + 6).toString()).toBe('FRAME\n');
  });

  it('actually zooms: late frames differ from early ones', () => {
    const y4m = readFileSync(y4mFile);
    const luma = (n: number) => y4m.subarray(HEADER.length + n * FRAME + 6, HEADER.length + n * FRAME + 6 + 65536);
    expect(luma(0).equals(luma(140))).toBe(false);
  });

  it.skipIf(!ffmpeg)('ffmpeg transcodes it with no flags at all', () => {
    const mp4 = join(dir, 'zoom.mp4');
    execFileSync(ffmpeg!, ['-y', '-loglevel', 'error', '-i', y4mFile, '-pix_fmt', 'yuv420p', mp4], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const frames = execFileSync(
      'ffprobe',
      ['-v', 'error', '-count_frames', '-select_streams', 'v', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', mp4],
    )
      .toString()
      .trim();
    expect(frames).toBe('150');
  });

  it.skipIf(!ffmpeg)('and composites it with another video', () => {
    const duet = join(dir, 'duet.mp4');
    execFileSync(
      ffmpeg!,
      ['-y', '-loglevel', 'error', '-i', y4mFile, '-f', 'lavfi', '-i', 'testsrc2=size=256x256:rate=30',
       '-filter_complex', '[0:v][1:v]hstack', '-t', '2', '-pix_fmt', 'yuv420p', duet],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    expect(readFileSync(duet).length).toBeGreaterThan(10000);
  });

  // The frei0r rung: ffmpeg dlopens a plugin that hosts the wasm module
  // via the wasmtime C API. The .so is built by npm run build:frei0r and
  // found through NACRE_FREI0R_DIR; without it, this documents itself.
  const frei0rDir = process.env.NACRE_FREI0R_DIR ?? '';
  it.skipIf(!ffmpeg || !frei0rDir || !existsSync(join(frei0rDir, 'nacre_mandel.so')))(
    'ffmpeg pulls frames straight out of the plugin',
    () => {
      const out = join(dir, 'frei0r.mp4');
      execFileSync(
        ffmpeg!,
        ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i',
         'frei0r_src=size=256x256:framerate=30:filter_name=nacre_mandel:filter_params=x',
         '-t', '2', '-pix_fmt', 'yuv420p', out],
        { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, FREI0R_PATH: frei0rDir } },
      );
      const frames = execFileSync(
        'ffprobe',
        ['-v', 'error', '-count_frames', '-select_streams', 'v', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', out],
      )
        .toString()
        .trim();
      expect(frames).toBe('60');
    },
  );
});
