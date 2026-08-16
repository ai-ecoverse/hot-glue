// ffmpeg-cut.mjs — cut streams to an mp4 inside ffmpeg.wasm. A
// capability, not a conductor: files in, one file out.
//
//   node scripts/ffmpeg-cut.mjs out.mp4 video.y4m:loop audio.wav
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';

delete globalThis.fetch; // the Emscripten core predates it
const { createFFmpeg } = await import('@ffmpeg/ffmpeg');
const require = createRequire(process.cwd() + '/');
const ffmpeg = createFFmpeg({ log: false, corePath: require.resolve('@ffmpeg/core/dist/ffmpeg-core.js') });
await ffmpeg.load();

const [out, ...specs] = process.argv.slice(2);
const args = [];
let hasAudio = false;
specs.forEach((spec, i) => {
  const loop = spec.endsWith(':loop');
  const path = loop ? spec.slice(0, -5) : spec;
  const buf = readFileSync(path);
  const file = buf.subarray(0, 4).toString() === 'RIFF' ? `${i}.wav` : `${i}.y4m`;
  if (file.endsWith('.wav')) hasAudio = true;
  ffmpeg.FS('writeFile', file, buf);
  if (loop) args.push('-stream_loop', '-1');
  args.push('-i', file);
});
args.push('-shortest', '-pix_fmt', 'yuv420p');
if (hasAudio) args.push('-c:a', 'aac');
await ffmpeg.run(...args, 'out.mp4');
writeFileSync(out, ffmpeg.FS('readFile', 'out.mp4'));
process.exit(0);
