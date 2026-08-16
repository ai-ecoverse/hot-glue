#!/usr/bin/env npx tsx
/**
 * hotglue — the interpreter for .hma files (hot melt adhesive).
 *
 * An .hma file is a film described in S-expressions, read by the same
 * reader that reads nacre, because the glue layer speaks the house
 * language. Each step's hot path runs in a sandbox; hotglue only
 * carries bytes between them and never does anything a glue gun
 * would be ashamed of.
 *
 * Steps:
 *   (let NAME (perl SCRIPT.pl))          zeroperl, Perl-5-in-wasm  → text
 *   (let NAME (speak TEXTVAR VOICE))     Kokoro under onnxruntime-wasm → f32 PCM
 *   (let NAME (wav PCMVAR))              wav.nacre wraps the container
 *   (let NAME (gpu SHADER.wgsl FRAMES))  WGSL compute via WebGPU → RGB
 *   (let NAME (rgb->y4m RGBVAR))         rgb2y4m.nacre glues the stream
 *   (let NAME (render FILES...))         a nacre module's stdout (e.g. Y4M)
 *   (cut [(loop) ]INPUTS...)             ffmpeg.wasm cuts the print
 *
 *   npx tsx scripts/hotglue.ts examples/film.hma
 */
import { execFileSync, execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { compile, read, Sym, type Node } from '../src/nacre/nacre.js';

const wasmtime = (() => {
  for (const bin of ['wasmtime', join(homedir(), '.local/bin/wasmtime')]) {
    try {
      execFileSync(bin, ['--version'], { stdio: 'pipe' });
      return bin;
    } catch {
      /* keep looking */
    }
  }
  throw new Error('hotglue needs wasmtime on the PATH');
})();

const dir = mkdtempSync(join(tmpdir(), 'hotglue-'));
const name = (n: Node): string => {
  if (n instanceof Sym) return n.name;
  throw new Error('expected a name');
};

// expand + assemble happen with the house tools; run under wasmtime
const wats = new Map<string, string>();
function nacreRun(files: string[], input: Buffer | string): Buffer {
  const key = files.join('+');
  if (!wats.has(key)) {
    const p = join(dir, `${wats.size}.wat`);
    writeFileSync(p, compile(files.map((f) => readFileSync(f, 'utf8')).join('\n')));
    wats.set(key, p);
  }
  return execFileSync(wasmtime, [wats.get(key)!], { input, maxBuffer: 1 << 28 });
}

type Value = Buffer | string;

async function step(form: Node[], env: Map<string, Value>): Promise<Value> {
  const op = name(form[0]);
  if (op === 'perl') {
    const { ZeroPerl } = await import('@6over3/zeroperl-ts');
    let out = '';
    const perl = await ZeroPerl.create({ stdout: (s: string) => (out += s) });
    await perl.eval(readFileSync(name(form[1]), 'utf8'));
    perl.flush();
    console.log(`  perl wrote ${out.trim().length} characters in the sandbox`);
    return out.trim();
  }
  if (op === 'speak') {
    const text = env.get(name(form[1]));
    const voice = form[2] ? name(form[2]) : 'af_heart';
    const out = join(dir, 'voice.f32');
    await promisify(execFile)('node', ['scripts/kokoro-voice.mjs'], {
      env: { ...process.env, TEXT: String(text), VOICE: voice, OUT: out,
        KOKORO_MIRROR: process.env.KOKORO_MIRROR ?? 'models/kokoro' },
    });
    const pcm = readFileSync(out);
    console.log(`  kokoro spoke ${(pcm.length / 4 / 24000).toFixed(1)}s in the sandbox`);
    return pcm;
  }
  if (op === 'wav') return nacreRun(['src/nacre/clj.nacre', 'examples/wav.nacre'], env.get(name(form[1]))!);
  if (op === 'gpu') {
    const out = join(dir, 'frames.rgb');
    await promisify(execFile)('node', ['scripts/gpu-render.mjs'], {
      env: { ...process.env, SHADER: name(form[1]),
        FRAMES: String((form[2] as number) ?? 150), OUT: out },
    });
    const rgb = readFileSync(out);
    console.log(`  webgpu rendered ${rgb.length / 196608} frames`);
    return rgb;
  }
  if (op === 'rgb->y4m')
    return nacreRun(['src/nacre/clj.nacre', 'examples/rgb2y4m.nacre'], env.get(name(form[1]))!);
  if (op === 'render')
    return nacreRun(form.slice(1).map(name), Buffer.alloc(0));
  throw new Error(`hotglue does not know how to ${op}`);
}

async function cut(out: string, inputs: Node[], env: Map<string, Value>): Promise<void> {
  delete (globalThis as { fetch?: unknown }).fetch; // the Emscripten core predates it
  const { createFFmpeg } = await import('@ffmpeg/ffmpeg');
  const require = createRequire(process.cwd() + '/');
  const ffmpeg = createFFmpeg({ log: false, corePath: require.resolve('@ffmpeg/core/dist/ffmpeg-core.js') });
  await ffmpeg.load();
  const args: string[] = [];
  let hasAudio = false;
  inputs.forEach((inp, i) => {
    const looped = Array.isArray(inp) && name(inp[0]) === 'loop';
    const varName = looped ? name((inp as Node[])[1]) : name(inp);
    const data = env.get(varName)!;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    const file = buf.subarray(0, 4).toString() === 'RIFF' ? `${i}.wav` : `${i}.y4m`;
    if (file.endsWith('.wav')) hasAudio = true;
    ffmpeg.FS('writeFile', file, buf);
    if (looped) args.push('-stream_loop', '-1');
    args.push('-i', file);
  });
  args.push('-shortest', '-pix_fmt', 'yuv420p');
  if (hasAudio) args.push('-c:a', 'aac');
  await ffmpeg.run(...args, 'out.mp4');
  writeFileSync(out, ffmpeg.FS('readFile', 'out.mp4'));
  console.log(`  ffmpeg.wasm cut ${out}`);
}

const file = process.argv[2] ?? 'examples/film.hma';
const forms = read(readFileSync(file, 'utf8'));
for (const form of forms) {
  if (!Array.isArray(form) || name(form[0]) !== 'film') continue;
  const out = name(form[1] as Node);
  const env = new Map<string, Value>();
  console.log(`hotglue: ${file} → ${out}`);
  for (const s of form.slice(2) as Node[][]) {
    const head = name(s[0]);
    if (head === 'let') env.set(name(s[1]), await step(s[2] as Node[], env));
    else if (head === 'cut') await cut(out, s.slice(1), env);
    else throw new Error(`unknown film step: ${head}`);
  }
}
process.exit(0);
