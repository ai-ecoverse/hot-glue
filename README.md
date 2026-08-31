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

Use the expander without installing anything:

```sh
npx @ai-ecoverse/hot-glue program.hma > program.wat
wasmtime program.wat
```

The prelude travels with it, so `(use prelude.hma)` resolves against the sources
shipped beside the program — there is no checkout for it to need. `--help` says
the rest; `-O` emits optimized wasm instead of WAT, if the optional `binaryen`
peer is installed. To keep it around, `npm install -g @ai-ecoverse/hot-glue`
and call it `hotglue`.

Or work on the language itself:

```sh
npm install
npm test                              # 20 suites, all under wasmtime
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

## Libraries, under their own meter

Module fragments in the Clojure accent, composed into a `(module …)` with
`(use …)`, and proven the house way — by the suite that measures itself:

- **`src/json-read.hma`** — a streaming JSON reader. A pull parser over
  windows of bytes the caller lends it: `$jr-fill` a chunk, ask `$jr-next`
  for the next event, lend another when it answers *more*. Structural bytes
  are never copied, the container stack is one bit per nesting level, and
  only string and number tokens pass through a buffer the caller sizes —
  a gigabyte of JSON parses in a few hundred bytes of state. Escapes
  unwind, `\uXXXX` mints UTF-8, surrogate pairs fuse; numbers keep their
  raw spelling so floats need no f64 to survive the trip.
- **`src/json-write.hma`** — the mirror: call the shape of the document and
  minimal JSON accretes in the caller's buffer. Commas place themselves
  from one "has elements" bit per level; `$jw-int` prints any i32,
  INT_MIN included, by holding the magnitude negative.
- **`src/glue-test.hma`** — clojure.test, poured hot. `(deftest …)`
  re-defines itself after every use, carrying the accumulated roster in
  its own macro body, so `(run-tests)` expands to the whole suite before
  the first byte of wasm exists. `(is-fail …)` forgives exactly one
  failure, which is how the framework's failure paths test themselves.
- **`src/cov.hma`** + **`src/cov-clj.hma`** — coverage as macros. `(hit)`
  stamps a bitmap byte and re-defines itself to stamp the next: the probe
  counter lives in the macro table, not in any runtime cell. `cov-clj`
  re-defines the accent's branching macros so every arm pays a probe;
  raw WAT `(if …)` stays below the meter, which is where the reporter
  itself must stand.
- **`src/glue-alloc.hma`** — the memory map, derived instead of
  declared: `(take name size)` claims the next band and defines
  `(name)` as its folded base. The allocator is a self-re-defining
  macro — it lives in the macro table and is gone before the module
  exists.
- **`src/canary.hma`** — sentinels that die out loud. `(defcanary
  addr)` posts a tripwire at a border; `(canaries-check)` traps the
  program the moment one has changed. Silent corruption becomes a
  crash with a location.

Every base address lives in **`src/glue-mem.hma`** and nowhere else —
reader at 8192, writer at 8448, framework at 8704, coverage bitmap at
16384. A host with its own memory map (say, a string pool that runs
past 8192) ships its own copy of that one file: `(use …)` resolves
names against the program's directory before the toolchain's, so the
host's map loads first and the libraries follow it wherever it points.

How these fare against wasm modules from the wild — shared memories,
Zig bands, the i64 seam — is
**[`docs/wilderness-memory.md`](docs/wilderness-memory.md)**.

`test/json-suite.hma` holds the whole argument to 100%: every assertion
and every probe, or FAIL. It passes three times over — expanded by stage
0, assembled by `as.hma`'s own binary, and compiled by the wasm compiler
with no TypeScript in the room. The verdict needs no particular runner:
wasmtime and `node:wasi` print the same transcript.

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
- **`examples/braid.hma`** — three civilizations, one linear memory, on
  purpose: two Zig modules banded by `--global-base` and `--stack`, a
  Hot Glue supervisor whose bands are `(take …)`n not pinned, canaries
  on every border, and an explicit-typed adapter module for the u64
  import — `wasm-merge` fuses the lot into one module with one memory,
  the overlay some platforms force, done structurally instead of
  luckily. `npm run build:braid`, then `wasmtime dist/braid.wasm`. The
  doctrine is [`docs/wilderness-memory.md`](docs/wilderness-memory.md).
- **`examples/perl-driver.hma`** — a supervisor with no memory of its own,
  importing zeroperl's and re-exporting it, so Perl 5 runs under plain wasmtime.
- **`tools/emscripten-gates/`** — the doctrine for giants that ship only as
  Emscripten builds: read the JS glue as text, classify every minified gate by
  what its body does, then serve the same gates from a host with no JavaScript
  in it. Executed rather than theorised — ffmpeg-core boots and prints its full
  `-version` banner with none of its own JavaScript ever running.

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
| `dist/braid.wasm` | `npm run build:braid` (zig; binaryen's wasm-merge) | `test/braid.test.ts`, the overlay done on purpose |
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
  **Python 3** with PyTorch (`npm run train:oyster`), **wasm-tools** for the
  component work (`scripts/make-envelope.mjs`, `test/envelope.test.ts`), a full
  Chromium for the playground and WebGPU tests (Playwright's stripped headless
  has no `navigator.gpu` — ask for the full build).

## Releases

Published to npm as
[`@ai-ecoverse/hot-glue`](https://www.npmjs.com/package/@ai-ecoverse/hot-glue).
Nobody types a version number: when `main` moves, `semantic-release` reads the
next one off the commit log, and `.github/workflows/release.yml` runs the suite,
publishes the tarball, tags the commit and writes the GitHub release.

Which makes the subject line load-bearing.

| Subject line | Bump | |
|---|---|---|
| `fix: …` | patch | 0.1.0 → 0.1.1 |
| `feat: …` | minor | 0.1.0 → 0.2.0 |
| any commit with a `BREAKING CHANGE:` footer | major | 0.1.0 → 1.0.0 |
| anything else | none | — |

Prose is still welcome. It moves to the body, under a conventional subject.

No npm token is stored anywhere. The workflow asks GitHub for an OIDC token and
npm trusts *the repository and the workflow file* rather than a secret somebody
has to rotate; the tarball gets a provenance attestation on the way past. The
one-time setup is on npmjs.com, under the package's **Trusted publisher**
settings: GitHub Actions, `ai-ecoverse/hot-glue`, workflow `release.yml`.

0.1.0 went out by hand, because npm has no settings page for a package that does
not exist yet and therefore nowhere to name a trusted publisher before the first
publish ([npm/cli#8544](https://github.com/npm/cli/issues/8544)). It is the only
release without a provenance attestation. Everything from 0.1.1 on is the
workflow's.

The published tarball is `dist/`: the compiled stage-0 bootstrap, and the `.hma`
sources beside it, where `(use prelude.hma)` looks for them. Everything else —
the tests, the examples, the film, the recipes below — stays here in the
repository.

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
