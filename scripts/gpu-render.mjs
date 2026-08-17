// gpu-render.mjs — the real prize: the set on the GPU.
//
// Runs the WGSL compute shader in a headless Chromium tab via WebGPU
// and writes raw RGB24 frames to OUT. On machines with silicon the
// adapter is silicon; here it is SwiftShader, which is Vulkan with a
// day job — either way the dispatch is the same and the hot path
// stays inside the GPU process. Frames come home over localhost
// HTTP, because the DevTools pipe still has its hundred-megabyte
// throat. WebGPU demands a secure context, which localhost is.
//
//   SHADER=examples/mandel.wgsl FRAMES=150 OUT=frames.rgb node scripts/gpu-render.mjs
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";

const SHADER = process.env.SHADER ?? "examples/mandel.wgsl";
const FRAMES = parseInt(process.env.FRAMES ?? "150", 10);
const OUT = process.env.OUT ?? "frames.rgb";

const PAGE = `<!doctype html><html><body><script type="module">
window.render = async (wgsl, frames) => {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("no WebGPU adapter");
  const device = await adapter.requestDevice();
  const module = device.createShaderModule({ code: wgsl });
  const uni = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const pix = device.createBuffer({ size: 262144, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const read = device.createBuffer({ size: 262144, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const pipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "main" } });
  const bind = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
    { binding: 0, resource: { buffer: uni } },
    { binding: 1, resource: { buffer: pix } },
  ]});
  const rgb = new Uint8Array(frames * 256 * 256 * 3);
  const t0 = performance.now();
  for (let f = 0; f < frames; f++) {
    const span = 3.5 * Math.pow(0.933, f);
    const params = new ArrayBuffer(16);
    const dv = new DataView(params);
    dv.setFloat32(0, -0.743643887037151 - span / 2, true);
    dv.setFloat32(4, 0.131825904205330 - span / 2, true);
    dv.setFloat32(8, span / 256, true);
    dv.setUint32(12, 128, true);
    device.queue.writeBuffer(uni, 0, params);
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bind);
    pass.dispatchWorkgroups(16, 16);
    pass.end();
    enc.copyBufferToBuffer(pix, 0, read, 0, 262144);
    device.queue.submit([enc.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const rgba = new Uint8Array(read.getMappedRange());
    const base = f * 256 * 256 * 3;
    for (let i = 0, j = 0; i < 256 * 256; i++) {
      rgb[base + j++] = rgba[i * 4];
      rgb[base + j++] = rgba[i * 4 + 1];
      rgb[base + j++] = rgba[i * 4 + 2];
    }
    read.unmap();
  }
  const ms = performance.now() - t0;
  await fetch("/frames", { method: "POST", body: rgb });
  const info = adapter.info ?? {};
  return { ms: Math.round(ms), vendor: info.vendor ?? "?", arch: info.architecture ?? "?" };
};
window.ready = true;
<\/script></body></html>`;

let frames = [];
const server = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/frames") {
    req.on("data", (c) => frames.push(c));
    req.on("end", () => { res.writeHead(200); res.end(); });
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(PAGE);
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-webgpu",
    "--enable-features=Vulkan", "--use-vulkan=swiftshader", "--use-webgpu-adapter=swiftshader"],
});
try {
  const page = await browser.newPage();
  await page.goto(base + "/");
  await page.waitForFunction("window.ready === true", undefined, { timeout: 30000 });
  const res = await page.evaluate(
    ([wgsl, n]) => window.render(wgsl, n),
    [readFileSync(SHADER, "utf8"), FRAMES],
  );
  writeFileSync(OUT, Buffer.concat(frames));
  console.log(
    `${FRAMES} frames in ${res.ms}ms on ${res.vendor}/${res.arch} — ` +
    `${Buffer.concat(frames).length} bytes of RGB, dispatched by WebGPU`,
  );
} finally {
  await browser.close();
  server.close();
}
