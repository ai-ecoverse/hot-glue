// perlmutt.mjs — perlmutt is Hot Glue (born nacre) in its mother tongue, and the
// mother of Perl if anyone asks. The conductor of the all-wasm A/V
// pipeline: every hot path below runs inside a WebAssembly sandbox,
// and this script only carries bytes between sandboxes.
//
//   render   examples/deepzoom.hma  → Y4M   (wasmtime, hotglue-assembled)
//   voice    Kokoro-82M               → PCM   (onnxruntime wasm, in Chromium)
//   contain  examples/wav.hma       → WAV   (the Lisp writes the header)
//   cut      ffmpeg.wasm              → MP4   (x264, in the sandbox)
//
// Needs: wasmtime on PATH, a Kokoro mirror (npm run fetch:kokoro),
// and one npm install. Produces perlmutt.mp4.
//
//   node scripts/perlmutt.mjs
import { execFileSync, execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const TEXT =
  process.env.TEXT ??
  "The pearl remembers the sand. This dive is a million deep. " +
  "The render is WebAssembly. The voice is WebAssembly. " +
  "Even the film you are watching was cut inside the sandbox.";
const MIRROR = process.env.KOKORO_MIRROR ?? "models/kokoro";
const OUT = process.env.OUT ?? "perlmutt.mp4";

const wasmtime = (() => {
  for (const bin of ["wasmtime", join(homedir(), ".local/bin/wasmtime")]) {
    try {
      execFileSync(bin, ["--version"], { stdio: "pipe" });
      return bin;
    } catch {
      /* keep looking */
    }
  }
  throw new Error("wasmtime not found");
})();

const dir = mkdtempSync(join(tmpdir(), "perlmutt-"));
const expand = (out, ...files) =>
  writeFileSync(join(dir, out), execFileSync("npx", ["tsx", "src/hotglue/cli.ts", ...files], { maxBuffer: 1 << 26 }));

console.log("expanding the hot glue modules…");
expand("deepzoom.wat", "src/hotglue/clj.hma", "examples/deepzoom.hma");
expand("wav.wat", "src/hotglue/clj.hma", "examples/wav.hma");
expand("as.wat", "src/hotglue/prelude.hma", "src/hotglue/as.hma");

console.log("assembling with the self-hosted assembler…");
const deepWasm = join(dir, "deepzoom.wasm");
writeFileSync(deepWasm, execFileSync(wasmtime, [join(dir, "as.wat")], {
  input: readFileSync(join(dir, "deepzoom.wat")),
  maxBuffer: 1 << 26,
}));

console.log("rendering two hundred frames…");
const y4m = execFileSync(wasmtime, [deepWasm], { maxBuffer: 1 << 27 });

console.log("asking Kokoro to speak…");
const voiceRaw = join(dir, "voice.f32");
await promisify(execFile)("node", ["scripts/kokoro-voice.mjs"], {
  env: { ...process.env, KOKORO_MIRROR: MIRROR, TEXT, OUT: voiceRaw },
});

console.log("the Lisp writes the WAV…");
const wav = execFileSync(wasmtime, [join(dir, "wav.wat")], {
  input: readFileSync(voiceRaw),
  maxBuffer: 1 << 26,
});

console.log("cutting the film in ffmpeg.wasm…");
delete globalThis.fetch; // the Emscripten core predates Node's fetch
const { createFFmpeg } = await import("@ffmpeg/ffmpeg");
const require = createRequire(process.cwd() + "/");
const ffmpeg = createFFmpeg({ log: false, corePath: require.resolve("@ffmpeg/core/dist/ffmpeg-core.js") });
await ffmpeg.load();
ffmpeg.FS("writeFile", "v.y4m", y4m);
ffmpeg.FS("writeFile", "a.wav", wav);
await ffmpeg.run("-stream_loop", "-1", "-i", "v.y4m", "-i", "a.wav", "-shortest",
  "-pix_fmt", "yuv420p", "-c:a", "aac", "out.mp4");
writeFileSync(OUT, ffmpeg.FS("readFile", "out.mp4"));
console.log(`${OUT}: render, voice, container, and cut — all of it wasm`);
process.exit(0);
