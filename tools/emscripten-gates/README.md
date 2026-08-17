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

The verdict on `@ffmpeg/core` 0.11 (closure-minified, the hard
case): **164 of 260 gates are servable without JavaScript** as
classified — 96 trampolines, 145 trivial forwards, clocks, stdio —
and the remainder is threads plumbing, `dlopen` stubs that only
print an error, and a tail of `other` to read by hand. The ledger
turns a porting decision from folklore into arithmetic.

Two honest limits, recorded: onnxruntime's esbuild-bundled `.mjs`
glue uses yet another minification dialect the finder does not parse
yet (the two-level chase needs one more declaration pattern); and a
ledger is not a shim — the follow-up tool would emit a Hot Glue
`env` module implementing the servable classes against WASI, plus
generated trampolines, and leave the rest as explicit imports for a
thin host. For binaries that also exist upstream as plain C, the
wasi-sdk rebuild (see `scripts/build-ffmpeg-wasi.sh`) remains the
cleaner door — the gate-reader is for the ones that don't.

    node tools/emscripten-gates/read-gates.mjs core.wasm core.js
    VERBOSE=1 …  # full ledger, every gate
