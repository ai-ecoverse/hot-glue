// kokoro-voice.mjs — the voice of the perlmutt pipeline.
//
// Kokoro-82M speaks inside a headless Chromium tab: the phonemizer is
// espeak-ng compiled to wasm, the inference is onnxruntime's wasm
// backend. The hot path never leaves the sandbox; this script only
// carries bytes to it and from it. Model files come from a local
// mirror (see npm run fetch:kokoro) served over localhost — the tab
// needs no network, and the hardcoded huggingface.co URLs inside
// kokoro-js are quietly redirected home.
//
//   KOKORO_MIRROR=models/kokoro TEXT="..." OUT=voice.f32 node scripts/kokoro-voice.mjs
//
// Output: raw 32-bit float PCM, mono, 24kHz — exactly what wav.hma
// drinks on stdin.
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { chromium } from "playwright-core";

const MIRROR = process.env.KOKORO_MIRROR ?? "models/kokoro";
const TEXT = process.env.TEXT ?? "The pearl remembers the sand.";
const OUT = process.env.OUT ?? "voice.f32";
const VOICE = process.env.VOICE ?? "af_heart";

const PAGE = `<!doctype html><html><body><script type="module">
  window.speak = async (text, voice) => {
    const { KokoroTTS } = await import("/kokoro.web.js");
    const tts = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", { dtype: "q8", device: "wasm" });
    const audio = await tts.generate(text, { voice });
    const bytes = new Uint8Array(audio.audio.buffer);
    let s = "";
    for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return { rate: audio.sampling_rate, b64: btoa(s) };
  };
  window.ready = true;
<\/script></body></html>`;

const mime = (p) =>
  p.endsWith(".mjs") || p.endsWith(".js") ? "text/javascript"
  : p.endsWith(".json") ? "application/json"
  : p.endsWith(".wasm") ? "application/wasm"
  : p.endsWith(".html") ? "text/html"
  : "application/octet-stream";

// the heavy bytes go over real HTTP; CDP has a hundred-megabyte throat
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  let file = null;
  if (path === "/") {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(PAGE);
  }
  if (path === "/kokoro.web.js") file = "node_modules/kokoro-js/dist/kokoro.web.js";
  else if (path.startsWith("/mirror/")) file = join(MIRROR, normalize(path.slice(8)));
  else if (path.startsWith("/ort/"))
    file = join("node_modules/@huggingface/transformers/dist", normalize(path.slice(5)));
  if (file && existsSync(file)) {
    res.writeHead(200, { "content-type": mime(file), "access-control-allow-origin": "*" });
    return res.end(readFileSync(file));
  }
  console.error("miss:", path);
  res.writeHead(404);
  res.end();
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const base = `http://127.0.0.1:${server.address().port}`;

async function launch() {
  const args = ["--no-sandbox", "--disable-dev-shm-usage"];
  try {
    return await chromium.launch({ args });
  } catch {
    return await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args });
  }
}

const browser = await launch();
try {
  const page = await browser.newPage();
  // kokoro-js and transformers.js phone huggingface.co and jsdelivr;
  // both calls come home as redirects to the local mirror
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === base) return route.continue();
    const hf = url.pathname.match(/resolve\/main\/(.*)$/);
    if (url.hostname === "huggingface.co" && hf)
      return route.fulfill({ status: 302, headers: { location: `${base}/mirror/${hf[1]}`, "access-control-allow-origin": "*" } });
    return route.fulfill({ status: 302, headers: { location: `${base}/ort/${url.pathname.split("/").pop()}`, "access-control-allow-origin": "*" } });
  });
  await page.goto(base + "/");
  await page.waitForFunction("window.ready === true", undefined, { timeout: 30000 });
  const t = Date.now();
  const res = await page.evaluate(([text, voice]) => window.speak(text, voice), [TEXT, VOICE]);
  const pcm = Buffer.from(res.b64, "base64");
  writeFileSync(OUT, pcm);
  console.log(
    `voice: ${res.rate} Hz, ${pcm.length / 4} samples, ` +
    `${(pcm.length / 4 / res.rate).toFixed(1)}s of speech in ${((Date.now() - t) / 1000).toFixed(1)}s, ` +
    `all inference in wasm`,
  );
} finally {
  await browser.close();
  server.close();
}
