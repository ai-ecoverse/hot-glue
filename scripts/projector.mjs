#!/usr/bin/env node
// projector.mjs — a lamp, not a reader.
//
// It satisfies a film's imports and never looks inside an .hma. The
// film arrives as a wasm binary compiled by hotglue.wasm; its import
// section is the manifest. Namespace "host" gets the four
// capabilities a sandbox cannot self-supply — perl (zeroperl), speak
// (Kokoro in Chromium), gpu (WebGPU in Chromium), cut (ffmpeg.wasm)
// — each running as its own sandboxed subprocess. Any other
// namespace ending in .hma is a filter, compiled on demand with the
// published hotglue.wasm flow and instantiated once, exactly as
// wasmtime satisfies a --preload.
//
//   node scripts/projector.mjs film.wasm [--preload NS=file.wasm]...
//   HOTGLUE_DIST=dist/hotglue   where the bootstrap artifacts live
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const filmPath = args.find((a) => !a.startsWith('--'));
const preloads = new Map();
for (let i = 0; i < args.length; i++)
  if (args[i] === '--preload') preloads.set(...args[++i].split('='));

const wasmtime = (() => {
  for (const bin of ['wasmtime', join(homedir(), '.local/bin/wasmtime')]) {
    try {
      execFileSync(bin, ['--version'], { stdio: 'pipe' });
      return bin;
    } catch {
      /* keep looking */
    }
  }
  throw new Error('the projector needs wasmtime for filter compilation');
})();
const dist = process.env.HOTGLUE_DIST ?? 'dist/hotglue';
const dir = mkdtempSync(join(tmpdir(), 'projector-'));

const filmMod = new WebAssembly.Module(readFileSync(filmPath));

function compileHma(ns) {
  return execFileSync(
    wasmtime,
    ['--dir', 'src', '--dir', 'examples', '--dir', '.',
     '--preload', `expand=${dist}/expand.wasm`, '--preload', `as=${dist}/as.wasm`,
     `${dist}/hotglue.wasm`, ns],
    { maxBuffer: 1 << 26 },
  );
}

function moduleFor(ns) {
  if (preloads.has(ns)) return new WebAssembly.Module(readFileSync(preloads.get(ns)));
  if (!ns.endsWith('.hma')) throw new Error(`projector: no module for import namespace ${ns}`);
  return new WebAssembly.Module(compileHma(ns));
}

const stub = { wasi_snapshot_preview1: { fd_read: () => 8, fd_write: () => 8 } };
let film;
const mem = () => new Uint8Array(film.exports.memory.buffer);
const str = (p, n) => Buffer.from(mem().slice(p, p + n)).toString('utf8');
const run = (cmd, a, env = {}) =>
  execFileSync(cmd, a, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'], maxBuffer: 1 << 28 });

let pending = Buffer.alloc(0);
const inputs = [];

// Perl runs under wasmtime itself: a Hot Glue supervisor drives the
// zeroperl reactor, compiled on demand like any filter. Perl wants a
// /dev/null; it gets an empty one to shout into.
let perlDriver;
function perlUnderWasmtime(script) {
  if (!perlDriver) {
    perlDriver = { drv: join(dir, 'perl-driver.wasm'), env: join(dir, 'envstub.wasm'), dev: join(dir, 'dev') };
    writeFileSync(perlDriver.drv, compileHma('examples/perl-driver.hma'));
    writeFileSync(perlDriver.env, compileHma('examples/envstub.hma'));
    mkdirSync(perlDriver.dev, { recursive: true });
    writeFileSync(join(perlDriver.dev, 'null'), '');
  }
  return execFileSync(
    wasmtime,
    ['--dir', '.', '--dir', `${perlDriver.dev}::/dev`,
     '--preload', `env=${perlDriver.env}`,
     '--preload', 'zeroperl=node_modules/@6over3/zeroperl-ts/dist/esm/zeroperl.wasm',
     perlDriver.drv],
    { input: script, maxBuffer: 1 << 26 },
  );
}

const host = {
  perl(pp, pl) {
    pending = perlUnderWasmtime(str(pp, pl));
    console.log(`  perl wrote ${pending.length} characters in the sandbox`);
    return pending.length;
  },
  speak(tp, tl, vp, vl) {
    // SPEAK_WASI=1 runs the whole voice under wasmtime: espeak-ng
    // (WASI) phonemizes, Kokoro-82M under patched tract synthesizes.
    // An order of magnitude slower than the Chromium tab, and pure.
    // Needs: KOKORO_TRACT_WASM (see tools/kokoro-tract) and
    // models/kokoro/onnx/model-fixed.onnx (scripts/fix-kokoro-onnx.py).
    if (process.env.SPEAK_WASI) {
      const dataDir = process.env.ESPEAK_DATA ?? '/usr/lib/x86_64-linux-gnu';
      const phonemes = execFileSync(
        wasmtime,
        ['--dir', dataDir, 'examples/native/espeak.wasm', dataDir, 'en-us'],
        { input: str(tp, tl), maxBuffer: 1 << 20 },
      ).toString().trim();
      console.log(`  espeak, compiled to wasi, wrote ${phonemes.length} phonemes under wasmtime`);
      const out = 'wasi-voice.f32';
      run(wasmtime, ['--dir', '.', '--env', 'PHONEMES',
        process.env.KOKORO_TRACT_WASM ?? 'tools/kokoro-tract/target/wasm32-wasip1/release/kokoro-tract.wasm',
        'models/kokoro/onnx/model-fixed.onnx', out], { PHONEMES: phonemes });
      pending = readFileSync(out);
      unlinkSync(out);
      console.log(`  kokoro, under patched tract, spoke ${(pending.length / 4 / 24000).toFixed(1)}s under wasmtime`);
      return pending.length;
    }
    const out = join(dir, 'voice.f32');
    run('node', ['scripts/kokoro-voice.mjs'], {
      TEXT: str(tp, tl), VOICE: str(vp, vl), OUT: out,
      KOKORO_MIRROR: process.env.KOKORO_MIRROR ?? 'models/kokoro' });
    pending = readFileSync(out);
    console.log(`  kokoro spoke ${(pending.length / 4 / 24000).toFixed(1)}s in the sandbox`);
    return pending.length;
  },
  gpu(sp, sl, frames) {
    const out = join(dir, 'frames.rgb');
    // GPU_WASI=1 dispatches through wasi:webgpu instead of a browser:
    // the mandel component under the wasi-gfx runtime (an extended
    // wasmtime carrying wgpu-core), headless on whatever Vulkan
    // answers — lavapipe will do. Build with
    // scripts/build-mandel-webgpu.sh, or point WASI_GFX_RUNTIME at
    // an existing checkout.
    if (process.env.GPU_WASI) {
      const rt = process.env.WASI_GFX_RUNTIME ?? 'tools/mandel-webgpu/wasi-gfx-runtime';
      const cmd = [join(rt, 'target/debug/runtime'), '--example', 'mandel'];
      if (!process.env.DISPLAY) cmd.unshift('xvfb-run', '-a');
      run(cmd[0], cmd.slice(1), {
        GFX_SHADER: str(sp, sl), GFX_FRAMES: String(frames), GFX_OUT: out,
        GFX_ONESHOT: '1', GFX_COMPONENT: join(rt, 'target/example-mandel.wasm'),
        RUST_LOG: 'error',
      });
      pending = readFileSync(out);
      console.log(`  wasi:webgpu rendered ${pending.length / 196608} frames under the wasi-gfx runtime`);
      return pending.length;
    }
    run('node', ['scripts/gpu-render.mjs'], { SHADER: str(sp, sl), FRAMES: String(frames), OUT: out });
    pending = readFileSync(out);
    console.log(`  webgpu rendered ${pending.length / 196608} frames`);
    return pending.length;
  },
  take(dst) {
    const need = dst + pending.length - film.exports.memory.buffer.byteLength;
    if (need > 0) film.exports.memory.grow(Math.ceil(need / 65536));
    mem().set(pending, dst);
    pending = Buffer.alloc(0);
  },
  input(p, n, loop) {
    inputs.push({ bytes: Buffer.from(mem().slice(p, p + n)), loop: !!loop });
  },
  // the cut runs under wasmtime: ffmpeg n5.1 + x264 compiled against
  // wasi-sdk (examples/native/ffmpeg.wasm, scripts/build-ffmpeg-wasi.sh)
  cut(pp, pl) {
    const out = str(pp, pl);
    const args = [];
    let hasAudio = false;
    inputs.forEach((inp, i) => {
      const file = inp.bytes.subarray(0, 4).toString() === 'RIFF' ? `${i}.wav` : `${i}.y4m`;
      if (file.endsWith('.wav')) hasAudio = true;
      writeFileSync(join(dir, file), inp.bytes);
      if (inp.loop) args.push('-stream_loop', '-1');
      args.push('-i', `/work/${file}`);
    });
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-shortest', '-pix_fmt', 'yuv420p');
    if (hasAudio) args.push('-c:a', 'aac');
    run(wasmtime, ['--dir', `${dir}::/work`, 'examples/native/ffmpeg.wasm', '-nostdin', '-hide_banner',
                   '-loglevel', 'error', ...args, '/work/out.mp4']);
    writeFileSync(out, readFileSync(join(dir, 'out.mp4')));
    console.log(`  ffmpeg, compiled to wasi, cut ${out} under wasmtime`);
  },
};

const imports = { host };
for (const imp of WebAssembly.Module.imports(filmMod))
  if (imp.module !== 'host' && !imports[imp.module])
    imports[imp.module] = new WebAssembly.Instance(moduleFor(imp.module), stub).exports;

console.log(`projector: ${filmPath}`);
film = new WebAssembly.Instance(filmMod, imports);
film.exports._start();
process.exit(0);
