# mandel-webgpu — the deep zoom as a wasi:webgpu component

The film's `gpu` capability had one browser left in it:
`scripts/gpu-render.mjs` dispatches the WGSL compute shader in a
headless Chromium tab, because a plain WASI sandbox has no GPU. The
[wasi-gfx](https://wasi-gfx.dev) project closes that gap — a
`wasi:webgpu` wit interface served by an extended wasmtime carrying
wgpu-core. This directory holds our guest and the small patch that
lets the pair render films.

- `app/` — the guest: a `wasm32-unknown-unknown` cdylib built with
  wit-bindgen against the runtime's example world, componentized with
  `wasm-tools component new`. The same dispatch as the Chromium page
  — uniform zoom params, one compute pass per frame, staging-buffer
  readback — with the zoom schedule where it always lived, in the
  renderer. It receives the WGSL from the host (`shader-source`),
  asks how many frames (`frame-count`), and hands each finished frame
  back as raw RGB24 (`emit-frame`).
- `wasi-gfx-runtime.patch` — against
  `wasi-gfx/wasi-gfx-runtime@772bc34`: the three world imports above
  (env-driven: `GFX_SHADER`, `GFX_FRAMES`, `GFX_OUT`), a
  `GFX_COMPONENT` override so the host binary runs from anywhere,
  and a `GFX_ONESHOT` exit so the winit event loop doesn't outlive a
  headless render.
- `scripts/build-mandel-webgpu.sh` — clones, patches, drops the app
  in, builds guest + component + host.

Then the projector's `gpu` capability takes the pure path:

    GPU_WASI=1 node scripts/projector.mjs examples/film.wasm

Verified against the Chromium renderer, same three frames: 258 of
589824 bytes differ (0.04%) — boundary pixels where lavapipe and
SwiftShader disagree by a single escape iteration and the palette
flips. Two correct implementations, one set.

Headless needs `xvfb-run` (the runtime opens a winit event loop even
when nothing is shown), `libxkbcommon0`/`libxkbcommon-x11-0`, and a
Vulkan implementation — `mesa-vulkan-drivers` brings lavapipe, which
is enough: the dispatch is real WebGPU either way, and on a machine
with silicon the same component lands on silicon.
