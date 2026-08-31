#!/usr/bin/env bash
#
# The bootstrap: stage 0 expands the three organs, and the assembler
# assembles them — itself first, then the expander, then the driver.
# Above stage 0 every program in the flow is a wasm binary, and these
# three are the ones the package ships.
#
# It needs a wasmtime, which is why it is a release-time step and not an
# install-time one: `prepack` runs it so the tarball carries the organs,
# and nobody who installs the package ever builds them.
#
#   bash scripts/bootstrap.sh [outdir]      (default dist/hotglue)
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
out="${1:-dist/hotglue}"

# Everything this script says goes to stderr. Its stdout belongs to the
# `npm pack` that may be running it, which reads the tarball's name there.
say() { echo "$@" >&2; }

if ! command -v wasmtime >/dev/null 2>&1; then
  say "bootstrap: no wasmtime, and the assembler has to run somewhere."
  say "  install one from https://wasmtime.dev — it is a release-time"
  say "  dependency only, and installing this package never runs this."
  exit 1
fi

mkdir -p "$out"

say "==> stage 0 expands the organs"
for organ in as expand hotglue; do
  npx tsx src/cli.ts "src/$organ.hma" > "$out/$organ.wat"
done

say "==> the assembler assembles itself, then the rest"
wasmtime run --invoke run "$out/as.wat" < "$out/as.wat" > "$out/as.wasm"
for organ in expand hotglue; do
  wasmtime run --invoke run "$out/as.wat" < "$out/$organ.wat" > "$out/$organ.wasm"
done

# Stage 3, asserted rather than assumed: the binary the text produced
# assembles that same text to the same bytes. A published tarball is a
# bad place to find out otherwise.
say "==> the fixpoint"
wasmtime run --invoke run "$out/as.wasm" < "$out/as.wat" > "$out/as.check"
if ! cmp -s "$out/as.wasm" "$out/as.check"; then
  say "    the assembler's binary does not reproduce itself — refusing to ship it"
  exit 1
fi
rm -f "$out/as.check"

say "bootstrap done — now: npm run -s compile -- program.hma > program.wasm"
