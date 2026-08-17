# Hot Glue – a design for WebAssembly macros

*A macro expander for WebAssembly, written in WebAssembly, operating on WebAssembly.*

The oyster deposits nacre around an irritant, layer over layer, until the irritant is smooth enough to sell. Macro expansion is the same secretion: the source form is the grain of sand, each expansion pass another layer, the validated module the pearl. The pearl does not remember the sand. The source map does.

This document takes the design space sketched by msimoni's observation – WAT is already S-expressions, so «Lisp-like» can be a thin surface – and the WAM/watup prototypes, and pushes it to a committed design. The four questions one could push separately (concrete macros, the GC AST, the expander architecture, the hygiene strategy) are answered together, because they are one decision surfaced four ways: hygiene dictates what a symbol is, symbols dictate the AST, the AST dictates the macro ABI, and the ABI is the expander.

---

## 1. Position in the design space

Three rungs exist:

1. **Mild static macros** – a preprocessor rewrites S-expressions into pure WAT before assembly (WAM, watup). Proven, useful, not self-hosting.
2. **Toolchain macros** – user passes over Binaryen IR or a custom assembler's forms. Powerful, but the macro language is C++ or JavaScript, and the sandbox is the host process.
3. **Wasm-native, homoiconic macros** – macros are Wasm functions from AST to AST; the expander is itself a Wasm module; Wasm GC represents code as data.

Hot Glue commits to rung 3 and bootstraps through rung 1. The stage-0 expander is a host-language program implementing exactly the semantics below; the stage-1 expander is the same program compiled to Wasm; the acceptance test for stage 1 is that it expands its own source. Rung 2 is not a rung here but an exit: the expanded AST lowers to WAT text today and can lower to Binaryen IR later without touching anything above it.

What Wasm 3.0 changed: GC gives heap-allocated structs, arrays, and `i31ref` with subtyping and cheap down-casts, which is precisely a Lisp cell library; typed function references give `call_ref`, which is precisely a macro table; tail calls make the expander's tree walk honest. The ambitious rung stopped being a research project and became an engineering weekend – several engineering weekends.

One vocabulary note used throughout: WAT is an S-expression *notation*, not a Lisp. It has the parentheses without the enlightenment: four-plus disjoint index spaces (types, functions, globals, tables, memories; locals and labels per function), positional grammar where `(param $x i32)` binds and `(local.get $x)` refers, and identifiers that are sugar the assembler erases into indices. Every design decision below is downstream of taking that seriously rather than pretending WAT is Scheme.

## 2. Code as data – the GC AST

The expander's object language and meta language share one value representation. In Wasm GC:

```wat
(rec
  ;; Every node carries $loc: an index into a side table of source
  ;; locations (file, line, col, provenance). Nodes stay two or three
  ;; words; locations survive expansion by index-copying.
  (type $node (sub (struct (field $loc i32))))

  ;; Symbols are interned: $id indexes the symbol table, comparison is
  ;; i32.eq. $scopes is the hygiene scope set (§ 5) — the only mutable
  ;; part of the design, and even it is copy-on-extend.
  (type $sym (sub final $node (struct
    (field $loc i32)
    (field $id i32)
    (field $scopes (ref $scopeset)))))

  (type $num (sub final $node (struct
    (field $loc i32)
    (field $ival i64)
    (field $fval f64)
    (field $flags i32))))          ;; int/float, width hint

  (type $str (sub final $node (struct
    (field $loc i32)
    (field $bytes (ref $bytes)))))

  (type $pair (sub final $node (struct
    (field $loc i32)
    (field $car (ref $node))
    (field $cdr (ref $node)))))

  (type $nil (sub final $node (struct (field $loc i32))))

  (type $bytes (array i8))
  (type $scopeset (array i32))
)
```

Pattern matching is `br_on_cast`:

```wat
(func $walk (param $n (ref $node)) (result (ref $node))
  (block $sym (result (ref $sym))
    (block $pair (result (ref $pair))
      (br_on_cast $pair (ref $node) (ref $pair) (local.get $n))
      (br_on_cast $sym  (ref $node) (ref $sym)  (local.get $n))
      (return (local.get $n)))        ;; atoms pass through
    ;; ... pair case
    )
  ;; ... symbol case
  )
```

Decisions, with the arguments that closed them:

**Pairs, not arrays.** Arrays win on locality; pairs win on structural sharing, O(1) cons, and quasiquote splicing – a macro that wraps a body shares the body's spine instead of copying it. Macro workloads are allocation-heavy and traversal-light, so sharing dominates. The lowerer may convert to arrays internally; the macro-visible representation is pairs.

**Interned symbols, identity by `$id`.** The symbol table (name bytes ↔ id) lives in the expander instance. Two symbols are the same name iff their ids are equal; whether they are the same *binding* is a separate question answered by scope sets, never by string comparison. This split – name equality cheap and syntactic, binding equality deliberate and jurisdictional – is the load-bearing wall of § 5.

**Immutable nodes.** No `mut` on any node field. Expansion is functional: macros return new trees sharing old ones. This makes re-expansion, caching, and «expand in the browser while typing» safe by construction, and it is what lets scope-set extension be copy-on-write.

**`i31ref` is an optimization, not a design.** Fixnums and even scope-free symbols could pack into `i31ref` unboxed. But a symbol without a scope-set slot cannot participate in hygiene, so `i31` symbols would exist only pre-expansion – two representations, one weekend lost to the seam between them. Ship structs; measure; maybe pack numbers later.

**Locations out-of-band.** The `$loc` side table stores `(file, line, col, origin)` where `origin` is either «read from source» or «synthesized by macro invocation N» – a provenance chain, since invocation N has its own call-site loc. Error reports walk the chain: *bad instruction here, introduced by `$for` here, invoked here.* Racket taught everyone this lesson; there is no reason to relearn it with less GC.

## 3. The macro ABI

A macro is a Wasm function:

```wat
(type $macro-fn (func
  (param (ref $node))      ;; the whole form, car included, unevaluated
  (param (ref $env))       ;; expansion environment (§ 4)
  (result (ref $node))))   ;; the replacement form

(table $macros 0 (ref null $macro-fn))
```

Dispatch: the expander keeps a map from symbol id to table index; application is `call_ref` after `table.get`. That is the entire calling convention, and it is deliberately the *only* one: an interpreted macro (stage 0) and a compiled macro (stage N) are indistinguishable to the expander because both sit behind `$macro-fn`.

Macros receive an import surface of exactly the AST intrinsics – `cons`, `car`, `cdr`, `sym`, `num`, `str`, `nil?`, `sym=?`, `gensym`, `syntax-error`, the quasiquote support routines, and the scope operations of § 5. No memory, no clocks, no I/O, no host. This settles the side-effect question by construction rather than policy: macros are pure because impurity is not importable. A macro that wants randomness is a macro that wants unreproducible builds, and it can want that somewhere else.

**How do macro bodies become `$macro-fn` functions?** Two phases of an answer:

- *Interpreted (first).* `(defmacro …)` bodies are written in a minimal meta-Lisp – lambda, if, let, recursion, fixnum arithmetic, the AST intrinsics, quasiquote – and run by a small interpreter inside the expander module. The interpreter's `apply` is wrapped in a `$macro-fn`, so the ABI holds.
- *Compiled (later).* The same meta-Lisp compiles to actual Wasm functions; instantiation needs either host support or a wasm-compiling-wasm runtime. Nothing upstream changes, which is the point of the ABI.

The meta-Lisp is kept small enough that its own compiler is a Hot Glue user program. That is the self-hosting spiral, and it is a feature, not a stunt: the spiral is the test suite.

## 4. The expander

Pipeline, all within one module boundary (three exports, one instance):

1. **read** – text → `(ref $node)`. A WAT-superset reader: WAT tokens, plus `` ` ``, `,`, `,@`, and `(defmacro …)`.
2. **expand** – the walk described below, to fixpoint per form.
3. **lower** – expanded AST → WAT text (stage 0/1) or binary or Binaryen IR (later). Name resolution, index assignment, local hoisting (§ 6.2) live here.

The walk:

```
expand(form, env):
  loop with fuel:
    if form is (H . rest) and H is a symbol resolving (per § 5) to a
    macro binding in env:
        scope  ← fresh-scope()                 ; one per invocation
        form'  ← apply(macro, flip(form, scope), env)
        form   ← flip(form', scope)            ; Bindings as Sets of Scopes
        continue                               ; re-expand the result
    else break
  if form is a core form:
      recurse into subforms per the core grammar table
  else if form is a pair:
      recurse into car and cdr
  return form
```

Three structural commitments:

**A core grammar table, because WAT is positional.** The expander cannot recurse blindly: `(param $x i32)` is a binder, `(local.get $x)` a reference, `(br $l)` a label reference, `(export "f")` opaque string data. The table maps each core head (`module`, `func`, `block`, `loop`, `if`, `param`, `local`, `global`, instruction mnemonics…) to a small grammar: which positions bind and into which index space, which refer, which are opaque, which are sub-forms to recurse into. This table is the expander's knowledge of WAT, it is data, and extending it is how future proposals (or the component model) get sugar without touching the algorithm.

**Fuel.** The loop carries a step budget (default generous, configurable, exhaustion is a `syntax-error` with the provenance chain). Macros do not halt because macro authors are careful; they halt because the expander is. The halting problem is not solved here, merely adjudicated.

**Phases, minimally.** Module-level forms expand left to right. `(defmacro …)` is evaluated at expansion time and extends `env` for everything after it – so macros that define macros are just interpretation, no tower required. Forward references to macros are errors, which is assembler discipline and stated as such. A full phase tower (à la Racket, with `for-syntax` imports) is deliberately out of scope until the compiled-macro stage forces the issue; the design reserves the `$env` parameter as the place it will land.

## 5. Hygiene – names are already sugar

The deep simplification, and the reason WAT is a *better* hygiene host than Lisp: WAT identifiers do not survive assembly. `$x` is notation for an index; the binary has no names. A Scheme hygiene system must eventually print readable, non-colliding names; Hot Glue's lowerer resolves every reference to an index and may print `$x.3` purely for the debugging eye. Hygiene therefore costs one resolution step that the assembler was performing anyway.

The mechanism is scope sets (ꜰʟᴀᴛᴛ's «Bindings as Sets of Scopes», simplified by WAT's lack of `local-expand`-style reflection):

- Every symbol carries a set of scope marks (`$scopeset`, sorted i32 array, copy-on-extend).
- Reading assigns each symbol its lexical scopes as usual (function scope, block scopes).
- Each macro invocation mints one fresh scope and *flips* it (symmetric difference) on the input before application and on the output after. Symbols that traveled from the call site get the scope flipped on and off – net unchanged. Symbols introduced by the macro template get it flipped on once – net marked.
- A reference resolves to the binding, in its index space, whose scope set is the largest subset of the reference's scope set; no unique maximum is an ambiguity error carrying both candidates' provenance.

Consequences, per index space:

- **Locals** – a macro-introduced `$tmp` cannot capture or be captured by a user's `$tmp`; the lowerer assigns them different indices and prints distinct names.
- **Labels** – `block`/`loop` labels introduced by a macro are invisible to `br` forms that arrive through macro arguments, and vice versa. Nested expansions of the same macro nest correctly with zero effort by the macro author. (WAT's binary form already encodes branch targets as relative depths – lexical structure with no names at all – so this is hygiene converging on what the bytecode always meant.)
- **Functions, globals, types** – same machinery at module level; a macro may `gensym` module-level helpers without colliding across invocations.

Deliberate capture remains available and loud: `(unhygienic ,sym)` re-marks a symbol with the scopes of the macro's call site – `datum->syntax` wearing a warning label. Anaphoric macros (a loop that binds `$it`, a `$for` that offers bare `(break)`) are thereby possible, and grep-able.

In this repository's dialect: a binding is a claim, a scope set is its jurisdiction, and capture is a ruling in favor of the wrong authority. Hygiene is not purity. It is due process.

## 6. Worked examples

### 6.1 `$for`, and the bug hygiene exists to kill

```lisp
(defmacro $for (init cond step body)
  `(block $break
     ,init
     (loop $continue
       (br_if $break (i32.eqz ,cond))
       ,body
       ,step
       (br $continue))))
```

(The design-sketch version placed `$done` at the tail of the block; WAT labels follow the block keyword. Macro design keeps colliding with what WAT actually is – the collisions are the specification writing itself.)

Naively expanded, a user's `(br $break)` inside `body` would target the macro's block – capture. Under § 5 the macro's `$break` carries the invocation scope, the user's does not, resolution keeps them apart, and the nested case:

```lisp
($for (...) (...) (...)
  ($for (...) (...) (...)
    (br_if $break (...))))   ;; user's own label, or ambiguity error
```

lowers with two distinct block labels, printed `$break` and `$break.1`. Should the macro *want* to offer `$break` anaphorically, it says `(block (unhygienic $break) …)` and the intent is in the source.

### 6.2 `$let`, and the hoisting protocol

WAT declares all locals at the function head. So `let` is not a local rewrite – it is a function-shaped rewrite, and this forces the one piece of expander/lowerer cooperation in the design:

```lisp
(defmacro $let (bindings body)
  ;; bindings: (($x expr) ($y expr) ...)
  `(block (result i32)
     ,@(map (lambda (b) `(local ,(car b) i32))       bindings)
     ,@(map (lambda (b) `(local.set ,(car b) ,(cadr b))) bindings)
     ,body))
```

The lowerer guarantees: any `(local …)` form encountered in a function body is hoisted to the function head, in encounter order, hygiene deciding its final index and printed name. Expansion stays local and compositional; the flat-locals rule becomes the lowerer's problem, once, instead of every binding macro's problem, forever. The same protocol generalizes to module level: a macro may emit `(hoist (type …))`, `(hoist (global …))`, `(hoist (import …))`, `(hoist (data …))` from expression position, which is the controlled answer to «how much of the module may macros generate» – all of it, but only through the hoisting door, so the lowerer can order, deduplicate, and attribute every hoisted form to its provenance. Inline strings – `(call $print "Fizz")` – are one line of sugar on this: a `hoist`ed data segment plus a pointer/length pair.

### 6.3 `$match` – every label macro-born

```lisp
($match (local.get $tag)
  (0 (call $on-atom))
  (1 (call $on-pair))
  (else (unreachable)))
```

expands (procedurally – the macro loops over its clauses building nested blocks) to the classic `br_table` ladder:

```wat
(block $done
  (block $else
    (block $c1
      (block $c0
        (br_table $c0 $c1 $else (local.get $tag)))
      (call $on-atom)
      (br $done))
    (call $on-pair)
    (br $done))
  (unreachable))
```

Four labels, all synthesized, all hygienic, nesting arbitrarily. This is the example that justifies procedural macros over template-only: the ladder's shape is a fold over the clause list, not a template.

### 6.4 `$unroll` – computation in the expander

```lisp
(defmacro $unroll (n var body)
  ;; n a literal fixnum; splices n copies of body with ,var bound
  ;; to each constant in turn
  (let loop ((i 0) (acc '()))
    (if (>= i (num-val n))
        `(splice ,@(reverse acc))
        (loop (+ i 1)
              (cons (subst body var `(i32.const ,i)) acc)))))
```

Arbitrary meta-computation – arithmetic, recursion, tree surgery – running inside the sandbox, emitting straight-line code. Constant folding and specialization macros are this same shape with more taste. `splice` is the standard flattening form: a macro returning several instructions where one form stood.

### 6.5 The fizzbuzz surface

With `$divisible?`, `$print-if`, `AND` as macros and inline strings as § 6.2 sugar, the fizzbuzz of the original sketch expands to plain WAT that `wasm-tools` accepts unchanged – the mild rung's demo, reproduced on the ambitious rung's machinery, which is the compatibility claim in executable form.

## 7. Errors and provenance

- `syntax-error` (the intrinsic) aborts expansion with a message node, the offending form, and the provenance chain from § 2 – the expansion-time stack trace.
- Validation errors are *lowering* errors: expand-then-validate is the stance. A macro may build ill-typed forms in flight; only the final module must validate, and when it does not, the report walks provenance back to the guilty invocation. Typed templates – macros declaring the stack shape they produce, checked at definition – are attractive, real, and explicitly future work; they require a WAT-level type algebra this document refuses to invent in a subsection.
- The lowerer emits the standard `name` section (from post-hygiene printed names) and a custom `hotglue.map` section carrying the location table, so DWARF-consuming and source-map-consuming tools can both be fed later without re-architecture.

## 8. The design, tabulated

| Aspect | Decision | Section |
|---|---|---|
| Representation | Immutable GC structs; pairs; interned symbols | § 2 |
| Macro ABI | `$macro-fn` behind `call_ref`; interpreted now, compiled later | § 3 |
| Purity | By construction – no impure imports exist | § 3 |
| Expansion order | Left-to-right, define-before-use, fixpoint per form, fueled | § 4 |
| WAT's positional grammar | Core grammar table, data-driven | § 4 |
| Hygiene | Scope sets; resolution at lowering; names are debug output | § 5 |
| Deliberate capture | `unhygienic`, loud and grep-able | § 5 |
| Locals / module forms from macros | The hoisting protocol | § 6.2 |
| Validation | Expand, then validate; provenance-routed errors | § 7 |
| Phase tower | Deferred; `$env` reserves the seat | § 4 |

## 9. Bootstrap and next steps

1. **Stage 0** – reader, expander, lowerer in TypeScript. *Implemented:* `src/bootstrap.ts`, one file – marks in a bigint bitset so the hygiene flip is one XOR, `defmacro` with quasiquote over a minimal meta-Lisp, the hoisting protocol for locals, inline strings pooled into data segments, printed names as debug output exactly as § 5 prescribes. `examples/fizzbuzz.hma` expands through three macro layers into WAT that wasmtime runs; `test/` holds the golden tests, label- and local-capture cases included. Stage 0 owns its shortcuts in its header comment: macro names resolve by name alone, quasiquote does not nest, no locations yet. The stage-0 expander can also lend `defmacro` back to the host language, which has special forms and no macros.
2. **Stage 1** – a macro library that makes WAT bearable at scale. *Implemented:* `src/prelude.hma` – `$when`, `$unless`, `$while`, `$let`, expression `$cond` (a macro that recurses through its own expansion), short-circuit `$and`/`$or`, and `$ops`, a table macro that computes packed opcode constants at expansion time. Stage 0 grew `&rest` parameters and multi-file input to carry it.
3. **Stage 2** – an assembler written in Hot Glue. *Implemented:* `src/as.hma` – reads the WAT dialect stage 0 prints on stdin, writes a binary module on stdout, runs under any WASI runtime. Linear-memory cells for the AST, no interning, no state structs: every pass re-walks the module tree, which was already the data structure. The subset it assembles is exactly the subset stage 0 emits – which includes the assembler's own expansion, and that is not a coincidence, it is the specification.
4. **Stage 3** – close the loop. *Proven:* the assembler, running as wasmtime-parsed text, assembles its own source to a binary; that binary assembles the same source again; the two outputs are byte-identical, and the grandchild still assembles other programs (`test/as.test.ts`). From here the external WAT parser is a convenience, not a dependency.
5. **Stage 4** – the expander itself in Wasm. *Implemented:* `src/expand.hma` – reader with quasiquote sugar, the meta-Lisp (closures, environments, the ten builtins the corpus uses), mark-flip hygiene with sorted mark chains standing in for stage 0's bigint bitsets, the full lowerer, and a byte-faithful reimplementation of the stage-0 printer. One knowing deviation from this document's original sketch: linear-memory cells, not the GC structs of § 2 – the expander must stay inside the subset `as.hma` assembles, or the loop opens. The acceptance criterion was met literally: stage 0 and stage 4 produce bit-identical output on FizzBuzz, on the assembler, and on the expander's own source – which means `expand.wat` running on its own source prints the text it is running as. And the loop is now closed at both ends: the assembler binary assembles the expander, the expander expands the assembler, and each binary rebuilds itself byte-identically through the other, with no TypeScript and no text parser anywhere inside (`test/expand.test.ts`).
6. **Stage 5** – GC, Binaryen, browsers. *Implemented, all three.* The assembler learned the GC binary format – rec groups, `sub`/`final` subtyping, struct types with ref-typed fields, per-local valtype runs, `struct.new`/`struct.get`, `ref.test`/`ref.cast`, and `br_on_cast` with its flags byte – and `examples/gc-ast.hma` puts the § 2 node algebra on a real heap: the abstract `$node`, its `$num`/`$pair`/`$nil` subtypes, pattern matching by cast, and a `$qlist` macro that builds GC literals procedurally at expansion time. Binaryen is the alternate lowering (`src/binaryen-lower.ts`, `hotglue -O`): the same printed WAT parses into Binaryen IR, optimizes, and – the test that matters – the optimized assembler still assembles byte-identically to the unoptimized one. And the browser is an expansion host in fact rather than in principle: `web/playground.html` embeds the Binaryen-lowered expander and assembler as base64, shims WASI in forty lines, and runs source → WAT → binary → execution entirely inside the tab; a headless Chromium test drives FizzBuzz and the GC demo through it (`test/web.test.ts`). What remained — arrays, `i31`, and the re-founding — became stage 6.
7. **Stage 6** – the expander moves onto the heap, and the surface learns an accent. The assembler completed its GC vocabulary: array types with `i8`/`i16` storage and `(mut …)` fields, `array.new_fixed`/`array.get_u`/`array.len`, `ref.i31`/`i31.get_s`, `ref.null` with abstract heap types, `ref.is_null`, `ref.eq`, `struct.set`, and `(type $t)` references on imports. On that vocabulary stands `src/expand-gc.hma`: the expander itself re-founded on the § 2 node algebra — `$node` subtypes for every cell, closures and macros as node citizens, mark sets as pair chains, mutable state in GC boxes, only bytes still linear because WASI speaks buffers. It is byte-identical to stage 0 on every corpus and on its own source, and the GC loop closes: the self-hosted assembler assembles the GC expander into a GC binary, which expands its own source, which reassembles to the same bytes. The oyster rebuilt its mantle out of pearl. And `src/clj.hma` gives the surface a Clojure accent — brackets read as parentheses, flat `let` and `cond` with `:else`, `when`/`when-not`/`while`/`dotimes`, threading `->` and `->>`, short-circuit `and`/`or`, folding arithmetic whose bare numbers wrap their own `i32.const`, and `$loop`/`recur` meeting at unhygienic transfer registers so nested loops nest and `recur` binds to the nearest loop, as it should. Two names wear a dollar on principle: a macro may not bear the name of a core form it must emit, so the value-if is `$if` and loop is `$loop`. `examples/collatz.hma` is the proof: Collatz by `loop`/`recur`, sums by `dotimes`, classification by flat `cond`, and a thread-first pipeline, all of it expanding to the same honest WAT.
8. **Stage 7** – floating point, placed where it costs nothing. Float literals are *symbols* to the expanders: hygiene never looks inside a number, so `0.933` travels through all three engines as text and comes out byte-identical, and neither Wasm expander ever learns to print a double the way JavaScript does. The assembler alone mints IEEE bits – `f64.const`/`f32.const` with a naive-but-deterministic decimal parse (within an ulp or two of a perfect strtod; the self-hosting fixpoint cares about determinism, not ulps), the full f32/f64 arithmetic, comparison, memory, and conversion sets, and `f32`/`f64` valtypes in locals, fields, and explicit signatures. The assembler computes the parse in f64 internally – it can afford to, being the one teaching itself to encode it – and smuggles results through a memory scratch slot so its own signatures stay all-i32 and inference-clean. Floats in a module's signatures put it in explicit-`(type …)` territory, like GC. The payoff is `examples/deepzoom.hma`: two hundred frames of f64 descent into the seahorse valley, a million-fold zoom that ten fixed-point bits could never survive, through the same flagless Y4M pipe. One archaeological note: the float work surfaced the assembler's reader still classifying tokens by leading digit – `3.141592653589793` read as `3` followed by a symbol of fraction – now aligned with the token-then-classify rule the expanders always had.

## 10. The binary wilderness

The reason to be at this altitude was never the altitude. It is that WebAssembly is where the old world's codebases are arriving – C, C++, Rust, Go, and every JavaScript host – and a module boundary is a module boundary regardless of what civilization lies behind it. An import is an import. Hot Glue's civility – macros, hygiene, an accent – costs nothing at the border, because it compiles away before the border is reached.

Two demos hold the door open. `examples/interop.hma` is three languages on one stack: the message lives in Hot Glue's memory; zlib's CRC-32 algorithm, compiled from C (`examples/native/crc32.c`), receives it byte by byte across the boundary – each module keeps its own memory, which is the discipline, not the limitation – and MurmurHash3's finalizer, compiled from Rust (`examples/native/fmix.rs`), mixes the result. One command runs it: `wasmtime run --preload c=… --preload rust=… interop.wat`. The checksum agrees with `node:zlib` to the digit, the mix agrees with Appleby's reference, and the hotglue-assembled binary sits in the same food chain as the wasmtime-parsed text. `examples/mandelbrot.hma` is the other direction – the civilized language doing the heavy computation itself: the set, rendered in ten-bit fixed point because the accent speaks only i32, printing a PPM under WASI and painting a browser canvas from the same bytes, `loop` by `while`, not a float in sight. The playground carries both; the guests are embedded beside the tools that host them.

Go and the larger C++ worlds enter by the same door – anything that exports functions from a wasm module is a neighbor, and the pattern shown here (feed bytes across, call, read back) is the whole protocol. The wilderness was never going to learn Lisp. It does not have to. It only has to link.

And it cuts film. `examples/mandelzoom.hma` makes the Lisp a video source in the ffmpeg sense, twice over. The first rung is the pipe: one hundred fifty frames of Mandelbrot descent, fourteen fractional bits deep, emitted as YUV4MPEG2 – self-describing, so `wasmtime mandelzoom.wat | ffmpeg -i - out.mp4` needs not a single flag, and `-filter_complex hstack` composites it against any other input in the graph. The second rung is the extension proper: `examples/native/frei0r_hotglue.c` is a frei0r source plugin – the plugin ABI ffmpeg dlopens at runtime – that embeds the hotglue-assembled module and hosts it through the wasmtime C API. ffmpeg opens the shared object, the shared object opens a WebAssembly runtime, the runtime opens a 1,034-byte binary assembled by an assembler written in the language it assembles, and frames come out: `ffmpeg -f lavfi -i "frei0r_src=filter_name=hotglue_mandel:…" out.mp4`. The same module exports `frame(n)` for the browser canvas. One source, three hosts – a pipe, a plugin, a tab – and the pixels do not know the difference. Transcode it, overlay it, mistreat it in any filter graph you own: that was always the point of speaking the local format.

The A/V half of this ecosystem has earned a name of its own: **perlmutt** – nacre, in its mother tongue, and the mother of Perl if anyone asks; a Lisp may claim that lineage with a straight face. (The supercomputer spells it Perlmutter and is named for Saul; the lowercase oyster intends no confusion.) Perlmutt is the discipline of § 10 applied to media: every hot path in a WebAssembly sandbox, the Lisp holding the containers and headers between them, glue code thin enough to read in one sitting. Its fullest expression is `scripts/perlmutt.mjs`, which conducts a four-sandbox orchestra: the deep zoom renders under wasmtime from a hotglue-assembled binary; Kokoro-82M speaks inside a headless Chromium tab – the phonemizer is espeak-ng compiled to wasm, the inference is onnxruntime's wasm backend, the model served from a local mirror (`npm run fetch:kokoro`) so the tab needs no network; `examples/wav.hma` – the Lisp, using its week-old floats to clamp, scale, and truncate – writes the RIFF container around the raw PCM; and ffmpeg.wasm cuts picture to voice. One command, one mp4, no native hot path anywhere. Two engineering notes for the next traveler: Chromium's DevTools pipe has a hundred-megabyte throat, so an 82M-parameter model must arrive over real localhost HTTP rather than through request-interception bodies; and a redirect that crosses origins must carry its CORS passport or the fetch dies at the border.

The glue layer, meanwhile, received a name from upstream that § 12 would later promote to the whole language: **hot glue**, file extension `.hma` – hot melt adhesive, the industrial term, which is better than any pun because it is simply what the thing is. An `.hma` film is described in S-expressions, and – since § 12 finished the thought – it is not interpreted by anything: it is a Hot Glue *program*. `(use reel.hma)` brings in the film macros, `hotglue.wasm` compiles `examples/film.hma` to `film.wasm`, and `scripts/projector.mjs` – a lamp, not a reader – runs it. A film is self-contained by rule: every wasm verb beyond the four capabilities is declared by a `(filter "verb" "program.hma")` form, the program's own `(use …)` names its macros, and the declaration compiles into the module's import section – so the film's manifest is carried by the binary itself, and the projector learns what to load by asking `WebAssembly.Module.imports`, never by reading a film. Its cast, each member sandboxed: **Perl 5**, compiled to WebAssembly by zeroperl, writes the narration – `examples/narration.pl` does arithmetic about its own film and signs its work, and the perlmutt pun thereby completes itself, the mother of Perl carrying an actual Perl. **Kokoro** speaks the words under onnxruntime-wasm. **WebGPU** – the real prize – renders the picture: `examples/mandel.wgsl` is the same escape-time iteration and palette as the Hot Glue renderers in WGSL compute, dispatched from a headless tab; here the adapter is SwiftShader (Vulkan with a day job) and still does 150 frames in two seconds; on real silicon it is real silicon, and the dispatch does not change. Two toll-booth notes: WebGPU demands a secure context, which `about:blank` is not and localhost is; and Playwright's default headless is a stripped shell without `navigator.gpu` – ask for the full Chromium. The frames come home as raw RGB and **`examples/rgb2y4m.hma`** – the Lisp again – glues them into Y4M with the same integer BT.601 as everything else, `examples/wav.hma` wraps the voice, and ffmpeg.wasm cuts the print. Six languages – Lisp, Perl, WGSL, C, Rust, JavaScript – and the only one that ever leaves a sandbox is the glue, which owns no hot path to leave with.

And then there is the door that never leaves the sandbox at all: ffmpeg itself, compiled to WebAssembly. The frei0r plugin brings the Lisp to native ffmpeg; ffmpeg.wasm brings ffmpeg to the Lisp's side of the wall, and on that side there is no native C artifact anywhere – the expander is wasm, the assembler is wasm, the renderer is wasm, and now the transcoder is wasm, an Emscripten build with x264 inside, barely slower than the native one on streams this size. `test/wasm-ffmpeg.test.ts` proves the chain: two Lisp-rendered Y4M streams transcoded and hstack-composited to H.264 with every instruction of every stage running in a WebAssembly sandbox. The playground offers the same as a button – «transcode in tab» fetches ffmpeg.wasm on demand and turns the module's stream into an mp4 playing in a `<video>` element, rendered, assembled, and encoded without leaving the page. The wilderness did not just learn to link; it moved in.

## 11. A language model, close to the metal

`examples/gpt.hma` is a transformer inference engine – the whole of one – in 393 lines of the Clojure accent. The architecture is nanochat's dialect in miniature: byte-level vocabulary, RMSNorm, rotary position embeddings, ReLU² MLP, no biases anywhere, unembedding tied to the embedding. The dialect was not adopted out of fashion. Strip a GPT to exactly that list and every remaining operation is a multiply, one reciprocal square root, or an exp – no subtraction a residual stream cannot phrase as addition, no GELU's erf, no learned positional table to page in. It is the transformer reduced to the arithmetic a self-assembled Lisp with week-old floats most likes to write.

The engine earns the section title honestly. `$matvec` walks weight rows in file order so every load is sequential; attention keeps a per-layer KV cache and softmaxes in two passes over a scores strip, max then normalize, which is one pass fewer than elegance would suggest and one more than overflow would allow; rotary rotation reads cosine and sine from tables computed at training time, so the engine never evaluates a trigonometric function; and `$exp` does range reduction where the `2^k` step is a single `f32.reinterpret_i32` of a shifted exponent field – the float format itself, asked politely, is an exponentiator. Sampling is greedy at temperature zero and seeded xorshift32 through the softmax CDF otherwise, so every utterance is reproducible by construction. Weights arrive on stdin in `.npt`: a six-word header – magic, vocabulary, width, depth, heads, context – then nothing but little-endian f32s in file order. The reader is thirty lines of pointer arithmetic, which is the entire model-loading ecosystem.

The resident model is **the oyster** (`scripts/train-oyster.py`): some 820k parameters – width 128, four layers, four heads – trained by CPU PyTorch on this repository's README and on the document you are reading. The oyster secretes over its own shell; it is the self-hosting joke told one level up, and it talks like the neighborhood it grew up in. Training exports `examples/oyster.npt` and, beside it, test vectors that hold the wasm engine to torch's answers: the greedy continuation must match byte for byte, and the final logits must agree to within f32 summation drift (`test/gpt.test.ts`; a randomly-initialized cross-check at width 32 agreed to 3×10⁻⁶, which is rounding, not luck). The playground carries the whole act: the weights ride gzipped inside `playground.html`, a `DecompressionStream` inflates them in-tab, and the prompt box feeds a model whose every instruction – expander, assembler, and now inference – executes inside the page. The engine does not know how small it is. The same 393 lines run any `.npt` you can afford to train; the format is one importer away from nanochat's own checkpoints, and the engine does not care who trained the bytes.

## 12. One name, one flow

The language was born nacre and grew a glue layer called hot glue, and for one commit the two pretended to be different things. They are not. The decree, from upstream and adopted in full: **Hot Glue** is the language, `.hma` is the extension, and there is no seam between the macro assembler and the film that uses it – `src/nacre` became `src/hotglue` (and plain `src` again once the work moved into a repository that already carries the name), every `.nacre` became `.hma`, the film interpreter surrendered the language's name and became `scripts/projector.ts`, and nacre survives only where it always belonged: in the oyster, in the pearl, and in perlmutt's mother tongue.

With the one name came the one law: after the bootstrap, no program in this repository is TypeScript. Its enforcement has three parts.

**Imports are explicit.** A source file declares its macro layers with `(use name.hma)` at top level – `(use prelude.hma)` opens the assembler, `(use clj.hma)` opens every accent-speaking example. Resolution is textual and byte-faithful: the form splices the named file from the lookup path, once per name anywhere in the program, comments and strings respected, everything else verbatim – so every engine that resolves imports produces the identical stream, and byte-parity survives one more layer. Nothing arrives by concatenation convention anymore; the CLI takes one entry file and the file says the rest.

**The compiler is a wasm binary.** `src/hotglue.hma` compiles to `hotglue.wasm`, and the flow is exactly as decreed: put the dependencies in the lookup path, run it against a `.hma`, get a `.wasm` back –

```
wasmtime --dir src --dir examples \
  --preload expand=expand.wasm --preload as=as.wasm \
  hotglue.wasm gpt.hma > gpt.wasm
```

The `--dir` flags *are* the lookup path – `(use …)` resolves against the preopened directories through WASI `path_open`, in order. The expander and assembler arrive as explicitly imported wasm modules and are driven through a byte protocol – `begin`, `in!`, `go`, `out` – which is § 10's wilderness discipline (feed bytes across, call, read back) applied to the toolchain's own organs. Both organs became WASI *reactors* for this: they export `run` for the classic stdin-to-stdout piping (`wasmtime run --invoke run as.wat < program.wat`) instead of `_start`, because a runtime treats a `_start`-bearing module as a command and re-instantiates it per exported call, which would amnesia the protocol between `begin` and `go`. Two archaeological finds along the way: the assembler's const emitter had `i32.const`'s opcode hardcoded where the table's byte belonged, and `i64.const` joined the table so the driver could state its `path_open` rights honestly.

**The fixpoint widened.** `hotglue.wasm` compiles `expand.hma`, `as.hma`, and `hotglue.hma` – its own expander, its own assembler, and itself – byte-identically to the bootstrap path, and the grandchild compiler still compiles everything else identically (`test/hotglue-wasm.test.ts`). The playground runs the very same driver: the page embeds `hotglue.wasm` beside the organs, hands it the expander and assembler as imported modules, shims `path_open` over a lookup path embedded in the page, and the textarea is stdin – an example in the tab now shows its honest `(use clj.hma)` line, and the WAT pane is read straight out of the expander instance the driver drove. `npm run bootstrap` builds the three artifacts with stage 0; `npm run compile -- program.hma` never touches TypeScript again.

The debt this section once recorded – a TypeScript film interpreter – is paid, by the same trick told twice. `src/reel.hma` is a macro library: `(film …)` expands the declarative film into a wasm module, so `examples/film.hma` is now a program like any other and compiles through the same `hotglue.wasm` flow. Its filters are explicitly imported wasm modules speaking the byte protocol, and the import *namespace* is the filter's source path – `(filter "wav" "examples/wav.hma")` becomes `(import "examples/wav.hma" "begin" …)` – so the compiled binary carries its own manifest and the projector (`scripts/projector.mjs`, a lamp) satisfies imports by reading `WebAssembly.Module.imports`, compiling each `.hma` namespace on demand with the published compiler, and providing exactly four capabilities as syscall-shaped subprocesses: perl in zeroperl, speech in a Kokoro tab, pixels in a WebGPU tab, the cut in ffmpeg.wasm. Buffers travel as handles – pointers to (ptr, len) cells – and the macro library's shared names rendezvous through `(unhygienic $reel.*)`, the same idiom `recur` uses. Byte-parity holds on the film across all three expanders; the stub-lamp test drives the compiled film through real filters without a browser in sight (`test/projector.test.ts`). Two hosts remain in this repository, and both are lamps: wasmtime, and a projector that has never read a film.

And the lamp is dimming by degrees, because the foreign giants turn out to be annexable one import section at a time. An audit of the binaries this repository already ships: zeroperl imports thirty-one WASI functions and exactly one JavaScript hook; ffmpeg-core imports two hundred sixty minified Emscripten functions; onnxruntime fifty-three. The first of these is therefore one stub away from a pure runtime — and `examples/perl-driver.hma` collects: a supervisor with *no memory of its own* that imports zeroperl's, re-exports it so WASI will speak to a memory-less guest, mallocs its buffers from Perl's own heap, and drives `zeroperl_init`/`zeroperl_run_file` directly. `examples/envstub.hma` — five lines — stands where the JavaScript wrapper stood, and Perl 5 runs under plain wasmtime with a `/dev/null` mounted for its comfort. The assembler learned memory imports and standalone memory exports for the occasion. The Emscripten captives need rebuilding against wasi-sdk before they can walk through the same door; the door itself is proven.

The first captive has been rebuilt. `examples/native/ffmpeg.wasm` is ffmpeg n5.1.6 with x264 inside, compiled against wasi-sdk 25 (`scripts/build-ffmpeg-wasi.sh` reproduces it), and the film's cut now runs under wasmtime: Y4M and WAV in, H.264 and AAC out, no Emscripten and no JavaScript runtime anywhere near the encoder. The seams the build crossed, recorded for the next traveler: n5.1 is the last major whose ffmpeg CLI does not hard-require threads (the 6.x transcode pipeline does, which is why n7.1 silently built only ffprobe — itself a fine WASI citizen); wasi-libc lacks `dup` and `tempnam` and spells `memalign` as `aligned_alloc` (`scripts/wasi-compat.h`); the emulated-mman header declares `madvise` but nothing defines it (a link-time stub does); and x264's `config.guess` predates wasm, so it cross-builds as `--host=i386-linux` while clang does the real targeting. Kokoro fell next, and it took a patch series to bring down. onnxruntime is Emscripten to its marrow, so the road went through tract, the pure-Rust ONNX runtime that compiles to `wasm32-wasip1` in one cargo invocation. Six patches (`patches/tract/`, upstream-shaped, apply with `git am`) taught it what Kokoro's fp32 export demands: rank-2 STFT signals, Range keeping its promised i64, symbolic Resize by exact rational scales, an axis-change guard for rank-0 constants, an einsum broadcast-skip soundness check, and ONNX slice-end clamping. A seventh repair belongs to the model, not the runtime: the export computes phase as `atan(imag/real)`, and silent frames are exactly zero under tract's exact STFT where onnxruntime leaves ~5e-8 of float dust — the graph divides 0/0 and survives elsewhere by luck. `scripts/fix-kokoro-onnx.py` nudges the divisor by 1e-12, and with that, **Kokoro-82M synthesizes finite audio under plain wasmtime** — 33,000 samples of it in the first breath (`tools/kokoro-tract`). And the phonemizer walked through the same door: `examples/native/espeak.wasm` is espeak-ng 1.51 compiled against wasi-sdk (`scripts/build-espeak-wasi.sh` — the dictionary data comes from the distro package, sidestepping espeak's native two-stage data build; the async layer, mbrola, and speechPlayer stay out; `system` and `tmpnam` are link-time stubs). Text becomes IPA in twenty milliseconds under wasmtime, IPA becomes tokens through the tokenizer vocabulary, tokens become voice through the patched tract — «The pearl remembers the sand.» took 67 seconds of pure-wasm inference for 1.4 seconds of audio, which is the price of purity until the wasm build learns SIMD. `SPEAK_WASI=1` switches the projector's speak capability onto this path; the Chromium tab remains the fast default. Alongside, `tools/emscripten-gates` records the doctrine for the giants that only exist as Emscripten builds: read the JS side of the binding — the glue is text and the mapping is in it — classify every minified gate by what its body does, and serve the same gates from a JS-free host. The doctrine has been executed, not just recorded: `make-shim.mjs` translates the mechanical gates into a WAT module in the Hot Glue subset — assembled by `as.hma`, which learned the i64 family, shared-memory limits, and explicit type references for the occasion — keeping Emscripten's glue-state variables as slots in the guest's own memory; the boot-ritual gates that call back into the module mid-ctors (pthread main-thread init, deferred and atexit table calls) go to a generic ninety-line thin host; and everything untranslated stubs loudly, so the porting loop is run–miss–translate–run, empirical to its core. Five turns of that loop and **ffmpeg-core 0.11 — closure-minified, pthreads and all — boots and prints its full `-version` banner with zero lines of its own JavaScript executed**.

And the component-model envelope was tried, as an experiment with a written verdict. The official door bites twice: `wasm-tools component new` demands typed WIT interfaces for any non-WASI import — the film's manifest-in-imports doctrine, namespaces that are file paths and a protocol spelled `in!`, sits entirely outside the component name grammar — and on a WASI reactor it silently drops every untyped core export, turning a filter into a black box that imports the whole WASI 0.2 constellation and exports nothing. But the law of names binds only the outer skin: core-level instantiation arguments take arbitrary strings, so a *generated* component (`scripts/make-envelope.mjs`) folds the film and its filters into one `.wasm` with the pathname manifest intact at the core seam — the filters' WASI satisfied by the projector's own two-line stub, no preview1 adapter anywhere, the six host capabilities lowered, `_start` lifted. The byte protocol crosses the component seam untouched, because it is all-scalar by construction — accidentally component-ABI-safe. The envelope is 3.6KB of skin around the three modules; its world reads `import host; export start` (`test/envelope.test.ts`). Two honest limits close the report: wasmtime's CLI has no `host` instance to link, so running the envelope awaits an embedder; and the `take` capability — the host writing bytes into guest memory — is exactly what the component model forbids by design, so a component-native reel would hand buffers back as `list<u8>` through the canonical ABI instead of pointing at them. The oyster can wear the new shell; the syscall in its heart would have to learn to receive rather than reach. And the GPU door is ajar after all: `wasi-gfx-runtime` — wasmtime extended with `wasi:webgpu` — builds and runs on this machine, and its `hello_compute` example (a guest wasm *component* dispatching a WGSL compute shader) executed headlessly under Xvfb on lavapipe's software Vulkan, after three small mercies: run the WIT fetch under bash not dash, install `libxkbcommon`, and lend winit a phantom display. A compute shader from inside wasm, no browser — which is exactly the shape of `mandel.wgsl`. So the shape was filled: `tools/mandel-webgpu` packages the deep zoom as a `wasi:webgpu` guest — a wasm component carrying the same dispatch as the Chromium page, uniform zoom params, one compute pass per frame, staging-buffer readback — and a small patch on the runtime's example world gives the host three env-driven doors (`shader-source`, `frame-count`, `emit-frame`) plus a one-shot exit so the winit loop doesn't outlive a headless render (`scripts/build-mandel-webgpu.sh` assembles the pair from a pinned upstream commit). The WGSL is not baked in: the host hands the shader over at runtime, so the film's `(gpu "examples/mandel.wgsl" 150)` names the same file on either path. `GPU_WASI=1` switches the projector's gpu capability onto it, and the verdict was measured rather than argued: against the Chromium renderer on the same three frames, 258 of 589,824 bytes differ — 0.04%, boundary pixels where lavapipe and SwiftShader disagree by one escape iteration and the palette flips. Two correct implementations, one set — and the component renders its frame *faster* than the tab that used to be mandatory. With that, the film's ledger reads: perl, speak, gpu, and cut — all four capabilities under a wasmtime in fact; the browser is now merely the fast default for speech, not a dependency of anything.

⁂

Most languages targeting Wasm brought their macros with them. The open seat was always the one closest to the instruction stream: a programmable assembler whose programs are its own assembly, sandboxed by the very runtime it emits for. WAT supplied the parentheses; GC supplied the cells; this document supplies the jurisprudence. What remains is secretion – layer over layer, until the irritant is a pearl.

⁂
