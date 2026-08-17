# emscripten-gates — reading the gates opened for JavaScript

An Emscripten binary confesses nothing: 260 imports named `a.b`,
`a.c`, … only its own JS glue understands. The strategy here is
better than giving up, and better than running the JS: **the glue is
text, and the mapping is in it.** Read the JS side of the binding to
learn what each gate does — then serve those same gates from a
JS-free host, entering through the door opened for JavaScript
without ever calling JavaScript.

`read-gates.mjs` produces the ledger:

1. It parses the `.wasm` import section itself (LEB by LEB) for exact
   type signatures — the binary is the authority on shape.
2. It finds the import object in the glue — `asmLibraryArg` /
   `wasmImports` in friendlier builds, or the closure-minified
   two-level form (`var d={a:Ge}` where `Ge` holds the namespace) —
   and brace-matches every entry, inline function bodies included.
3. It classifies each gate by what the JS body actually does:
   syscalls, stdio, clocks, randomness, memory growth, aborts,
   environ, timezone — the WASI-shaped majority — plus the
   `invoke_*` longjmp trampolines (stack-save, indirect call through
   the module's own table, catch, `setThrew`), which contain no JS
   semantics at all and can be generated as a wasm-side shim.

The verdict on `@ffmpeg/core` 0.11 (closure-minified, pthreads,
the hard case): every one of its 259 function gates resolves to a
readable body. The ledger turns a porting decision from folklore
into arithmetic.

And the ledger grew hands. `make-shim.mjs` acts on it: it emits a
WAT module — in the Hot Glue subset, assembled by `as.hma` like
everything else here — exporting every gate, translating the ones
whose bodies translate mechanically (consts, `memcpy_big` as one
`memory.copy`, the `Date.now` family as WASI `clock_time_get`
arithmetic, the fd gates as straight WASI forwards — Emscripten's
iovec walk has WASI's exact layout — and the glue's mutable state
vars as 4-byte slots in the guest's own memory, below
`GLOBAL_BASE`). Gates that call back into the module's own exports
mid-ctors (pthread main-thread init, deferred and atexit table
calls) are marked for the host; everything else is a loud stub that
names itself and traps. `thin-host.mjs` is the generic loader: ~40
lines of WASI, the sidecar's memory descriptor and export map, ctors
then `main` with argv malloc'd into the module's heap.

The milestone, reached after five turns of the miss-and-translate
loop: **ffmpeg-core boots and prints its full `-version` banner with
zero lines of ffmpeg-core.js executed** (`test/gates.test.ts`
re-proves it). The porting loop is empirical — run, read the miss,
translate that one gate, run again — not speculative.

Honest limits, recorded: onnxruntime's esbuild-bundled `.mjs` glue
uses a minification dialect the finder does not parse yet; the fd
gates forward to WASI but no filesystem beyond stdio is served, so
commands that open files need more gates translated; and threads
never spawn — fine for `-version`, a real port would confront
`pthread_create`. For binaries that also exist upstream as plain C,
the wasi-sdk rebuild (see `scripts/build-ffmpeg-wasi.sh`) remains
the cleaner door — the gate tools are for the ones that don't.

    node tools/emscripten-gates/read-gates.mjs core.wasm core.js
    VERBOSE=1 …  # full ledger, every gate
    node tools/emscripten-gates/make-shim.mjs core.wasm core.js out/
    wasmtime run --invoke run dist/hotglue/as.wat < out/shim.wat > out/shim.wasm
    node tools/emscripten-gates/thin-host.mjs core.wasm out/ -- -version
