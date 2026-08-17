# Hot Glue

**A macro expander for WebAssembly, written in WebAssembly, operating on WebAssembly.**

Hot melt adhesive — the industrial term, which is better than any pun because it
is simply what the thing is. Hot Glue is a Lisp whose object language is WAT and
whose meta language is itself. Macros are hygienic. The expander expands its own
source. The assembler assembles its own source. The compiler is a 2.5 KB wasm
binary that compiles the expander, the assembler, and itself, byte-identically to
the bootstrap path — and after the bootstrap, no program here is TypeScript.

File extension: `.hma`.

---

## Quick start

```sh
npm install
npm test                              # 15 suites, all under wasmtime
```

Expand a program to WAT with the stage-0 bootstrap and run it:

```sh
npx tsx src/cli.ts examples/fizzbuzz.hma > /tmp/fizzbuzz.wat
wasmtime /tmp/fizzbuzz.wat
```

Or close the loop — build the wasm compiler and never touch TypeScript again:

```sh
npm run bootstrap                     # dist/hotglue/{expand,as,hotglue}.wasm
npm run -s compile -- examples/fizzbuzz.hma > /tmp/fizzbuzz.wasm
wasmtime /tmp/fizzbuzz.wasm
```

The browser is an expansion host too. `npm run build:web` writes
`web/playground.html`: source → WAT → binary → execution, entirely inside one
tab, no server and nobody phoned.

## What it looks like

Macros are the argument; the machine is the proof.

```lisp
(defmacro $divisible? (n d)
  `(i32.eqz (i32.rem_u ,n ,d)))

(defmacro $for (init test step body)
  `(splice
     ,init
     (block $break
       (loop $continue
         (br_if $break (i32.eqz ,test))
         ,body
         ,step
         (br $continue)))))
```

`$break` and `$continue` are macro-born labels; hygiene keeps them from
capturing yours. Beneath the surface, `src/clj.hma` teaches the reader an
accent — brackets, `loop`/`recur`, threading, folding arithmetic whose bare
numbers wrap their own `i32.const`:

```lisp
(use clj.hma)

(func (export "steps") (param $n i32) (result i32)
  ($loop [$x (local.get $n) $count 0]
    ($if (= (local.get $x) 1)
         (local.get $count)
         (recur ($if (zero? (rem (local.get $x) 2))
                     (quot (local.get $x) 2)
                     (+ (* 3 (local.get $x)) 1))
                (inc (local.get $count))))))
```

Both compile to the same honest WAT.

## The spiral

Every rung is the acceptance test for the one below it.

| | | |
|---|---|---|
| **Stage 0** | `src/bootstrap.ts` | 458 lines of TypeScript: reader, expander, lowerer. The only TypeScript that matters. |
| **Stage 2** | `src/as.hma` | An assembler written in Hot Glue. WAT in on stdin, a binary module out on stdout. |
| **Stage 3** | — | The assembler assembles its own source; the child assembles it again; the two binaries are byte-identical. |
| **Stage 4** | `src/expand.hma` | The expander itself in wasm. `expand.wat` run on its own source prints the text it is running as. |
| **Stage 6** | `src/expand-gc.hma` | The expander re-founded on Wasm GC — nodes as `struct` subtypes, matched by `br_on_cast`. |
| **Stage 7** | — | Floating point, placed where it costs nothing: floats are *symbols* to the expanders, and only the assembler mints IEEE bits. |
| **The flow** | `src/hotglue.hma` | The compiler as a wasm binary, driving expander and assembler as imported modules over a four-verb byte protocol. |

`src/prelude.hma` is the macro library that makes WAT bearable at scale;
`src/reel.hma` expands a declarative film into a wasm module.

## The binary wilderness

A module boundary is a module boundary regardless of what civilization lies
behind it. Hot Glue's civility compiles away before the border is reached.

- **`examples/interop.hma`** — three languages on one stack: the message in Hot
  Glue's memory, CRC-32 from C, MurmurHash3's finalizer from Rust.
- **`examples/mandelzoom.hma`** — the Lisp as an ffmpeg video source, twice
  over: a self-describing Y4M pipe, and `examples/native/frei0r_hotglue.c`, a
  frei0r plugin that hosts the assembled module through the wasmtime C API.
- **`examples/gpt.hma`** — a transformer inference engine, the whole of one, in
  395 lines of the Clojure accent. Byte-level vocabulary, RMSNorm, rotary
  embeddings, ReLU² MLP. `$exp` does its `2^k` step as a single
  `f32.reinterpret_i32` of a shifted exponent field: the float format itself,
  asked politely, is an exponentiator.
- **`examples/film.hma`** — a film is a program. `scripts/projector.mjs` is a
  lamp that has never read a film; it learns what to load by asking
  `WebAssembly.Module.imports`. Six languages appear in the credits — Lisp,
  Perl, WGSL, C, Rust, JavaScript — and the only one that ever leaves a sandbox
  is the glue, which owns no hot path to leave with. The picture no longer
  needs a browser either: `GPU_WASI=1` dispatches `examples/mandel.wgsl` as a
  `wasi:webgpu` component instead of a Chromium tab, and the two renderers
  disagree on 0.04% of bytes — boundary pixels where two software Vulkans part
  company by one escape iteration.
- **`examples/perl-driver.hma`** — a supervisor with no memory of its own,
  importing zeroperl's and re-exporting it, so Perl 5 runs under plain wasmtime.

The full argument, stage by stage, is **[`docs/wasm-macros.md`](docs/wasm-macros.md)** — the
design document that came first and was kept honest afterwards.

## Things you build yourself

Four artifacts are described here by recipe rather than carried as commits. The
tests that need them skip cleanly when they are absent, so nothing below is
required to work on the language.

| Artifact | Build it with | Wanted by |
|---|---|---|
| `examples/native/ffmpeg.wasm` | `npm run build:ffmpeg` (wasi-sdk 25; ffmpeg n5.1.6 with x264) | the film's cut, `test/projector.test.ts` |
| `examples/native/espeak.wasm` | `npm run build:espeak` (wasi-sdk; espeak-ng 1.51) | `SPEAK_WASI=1`, the pure-wasm voice |
| `examples/oyster.npt` | `npm run train:oyster` (CPU PyTorch, ~820k params) | `test/gpt.test.ts`, the playground's prompt box |
| `web/playground.html` | `npm run build:web` | the browser as expansion host |
| `tools/mandel-webgpu/wasi-gfx-runtime/` | `npm run build:webgpu` (clones and patches wasi-gfx-runtime; needs cargo and wasm-tools) | `GPU_WASI=1`, the browserless GPU path in `test/projector.test.ts` |

Kokoro's weights arrive with `npm run fetch:kokoro`. The six patches under
`patches/tract/` teach the pure-Rust ONNX runtime what Kokoro's fp32 export
demands; they are upstream-shaped and apply with `git am`.

## Requirements

- **Node 20+** and **npm** — the bootstrap, the tests, the lamps.
- **[wasmtime](https://wasmtime.dev)** — every rung above stage 0 is proven by
  running it. Without wasmtime the suite still collects, but the interesting
  tests skip.
- Optional: **clang** and **rustc** with wasm targets (`npm run build:native`),
  **Python 3** with PyTorch (`npm run train:oyster`), a full Chromium for the
  playground and WebGPU tests (Playwright's stripped headless has no
  `navigator.gpu` — ask for the full build).

## Where this came from

Hot Glue was explored inside
[trieloff/allegorithm](https://github.com/trieloff/allegorithm), on the
`claude/wasm-macro-design-tszl1h` branch, and carved out here with its history
intact — twenty-six commits, beginning as *nacre* and renamed partway through.
`git log --follow src/bootstrap.ts` still reaches «Nacre stage 0», across both
the rename and the flattening into this repository.

Nacre survives where it always belonged: in the oyster, in the pearl, and in
perlmutt's mother tongue.

The exploration is still running up there, so the carve is a script rather than
an afternoon. `tools/upstream-sync/` holds the whole transform — the path
include-set, the content-rewrite rules, and the upstream sha tracked so far:

```sh
tools/upstream-sync/sync.sh --check     # has upstream moved? (exit 3 = yes)
tools/upstream-sync/sync.sh --verify    # rebuild this tree from upstream, diff
tools/upstream-sync/sync.sh             # port what's new onto a branch
```

`--verify` is the load-bearing one: it re-derives every carried file from
upstream and compares byte for byte. That the transform is *reproducible*, not
merely done, is what lets new upstream commits apply as ordinary patches — they
arrive already spelling `src/` where upstream said `src/hotglue/`.

## License

Apache-2.0. See [LICENSE](LICENSE).
