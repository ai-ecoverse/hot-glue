# tract patches — the road to Kokoro-82M under WASI

Six patches against [sonos/tract](https://github.com/sonos/tract)
at `8d8b252`, in the order the model demanded them. With all six,
tract loads, optimizes, and runs Kokoro-82M's fp32 ONNX export —
natively and compiled to `wasm32-wasip1` under wasmtime — producing
finite audio. Apply with `git am patches/tract/*.patch` inside a
tract checkout; drive with `tools/kokoro-tract`.

1. **onnx: accept rank-2 signals in STFT** — the spec says
   `[batch][signal][1|2]`; PyTorch exports `[batch][signal]` and
   onnxruntime accepts it.
2. **hir: keep Range's promise of i64 output for symbolic bounds** —
   the rules promise i64 when bounds are TDim; wire() delivered TDim.
   Also asserts the minted length symbol non-negative, which the dim
   algebra needs to prove `(1+2*range)/2 == range`.
3. **resize: symbolic output shapes for exact fractional scales** —
   continued-fraction rationalization, exact round-trips only:
   `600*S` at scale 1/300 is `2*S`.
4. **optim: don't rewire a scalar const through an inapplicable axis
   change** — a rank-0 scalar can not take `Add(1)`; decline and let
   Const::change_axes block the propagation gracefully.
5. **einsum: only skip an upstream broadcast when the output fact
   survives** — bypassing MultiBroadcastTo is unsound when the
   broadcast axis reaches the output from that input alone.
6. **slice: clamp symbolic ends to the axis dimension** — ONNX
   semantics; models traced with a dummy length slice short baked
   constants with runtime lengths.

One repair belongs to the model, not to tract:
`scripts/fix-kokoro-onnx.py` nudges the phase-computation divisor by
1e-12, because the export computes `atan(imag/real)` and silent
frames are exactly zero once tract's exact STFT replaces
onnxruntime's float dust. tract was more correct than the graph.
