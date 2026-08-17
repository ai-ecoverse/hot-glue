#!/usr/bin/env bash
# build-mandel-webgpu.sh — the deep zoom without the browser.
#
# Assembles the wasi:webgpu path for the film's gpu capability:
# clones wasi-gfx-runtime (wasi-webgpu on an extended wasmtime),
# applies our small patch (frame sink, frame count, shader source and
# a one-shot exit for the example world), drops in the mandel guest
# app, builds the guest for wasm32-unknown-unknown, componentizes it
# with wasm-tools, and builds the host runtime. After this, the
# projector renders with GPU_WASI=1 — wgpu-core against whatever
# Vulkan answers (mesa's lavapipe suffices, headless under xvfb-run).
#
#   scripts/build-mandel-webgpu.sh [checkout-dir]
#
# Needs: rust with target wasm32-unknown-unknown, wasm-tools,
# and for running: xvfb-run, libxkbcommon, mesa-vulkan-drivers.
set -euo pipefail

SHA=772bc344d3d0e24ba2d3ee29fc0033fc6ccea81d
HERE=$(cd "$(dirname "$0")/.." && pwd)
DIR=${1:-$HERE/tools/mandel-webgpu/wasi-gfx-runtime}

if [ ! -d "$DIR/.git" ]; then
  git clone https://github.com/wasi-gfx/wasi-gfx-runtime.git "$DIR"
fi
git -C "$DIR" checkout --quiet "$SHA"
git -C "$DIR" apply --check "$HERE/tools/mandel-webgpu/wasi-gfx-runtime.patch" 2>/dev/null \
  && git -C "$DIR" apply "$HERE/tools/mandel-webgpu/wasi-gfx-runtime.patch" \
  || echo "patch already applied, continuing"

rm -rf "$DIR/examples/apps/mandel"
mkdir -p "$DIR/examples/apps/mandel"
cp -r "$HERE/tools/mandel-webgpu/app/." "$DIR/examples/apps/mandel/"

cd "$DIR"
cargo build --package mandel --release --target wasm32-unknown-unknown
wasm-tools component new \
  target/wasm32-unknown-unknown/release/mandel.wasm \
  -o target/example-mandel.wasm
cargo build -p runtime

echo "built: $DIR/target/example-mandel.wasm (component)"
echo "built: $DIR/target/debug/runtime (host)"
echo "try:   GPU_WASI=1 node scripts/projector.mjs <film.wasm> …"
