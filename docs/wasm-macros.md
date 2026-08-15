# Nacre – a design for WebAssembly macros

*A macro expander for WebAssembly, written in WebAssembly, operating on WebAssembly.*

The oyster deposits nacre around an irritant, layer over layer, until the irritant is smooth enough to sell. Macro expansion is the same secretion: the source form is the grain of sand, each expansion pass another layer, the validated module the pearl. The pearl does not remember the sand. The source map does.

This document takes the design space sketched by msimoni's observation – WAT is already S-expressions, so «Lisp-like» can be a thin surface – and the WAM/watup prototypes, and pushes it to a committed design. The four questions one could push separately (concrete macros, the GC AST, the expander architecture, the hygiene strategy) are answered together, because they are one decision surfaced four ways: hygiene dictates what a symbol is, symbols dictate the AST, the AST dictates the macro ABI, and the ABI is the expander.

---

## 1. Position in the design space

Three rungs exist:

1. **Mild static macros** – a preprocessor rewrites S-expressions into pure WAT before assembly (WAM, watup). Proven, useful, not self-hosting.
2. **Toolchain macros** – user passes over Binaryen IR or a custom assembler's forms. Powerful, but the macro language is C++ or JavaScript, and the sandbox is the host process.
3. **Wasm-native, homoiconic macros** – macros are Wasm functions from AST to AST; the expander is itself a Wasm module; Wasm GC represents code as data.

Nacre commits to rung 3 and bootstraps through rung 1. The stage-0 expander is a host-language program implementing exactly the semantics below; the stage-1 expander is the same program compiled to Wasm; the acceptance test for stage 1 is that it expands its own source. Rung 2 is not a rung here but an exit: the expanded AST lowers to WAT text today and can lower to Binaryen IR later without touching anything above it.

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

The meta-Lisp is kept small enough that its own compiler is a Nacre user program. That is the self-hosting spiral, and it is a feature, not a stunt: the spiral is the test suite.

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

The deep simplification, and the reason WAT is a *better* hygiene host than Lisp: WAT identifiers do not survive assembly. `$x` is notation for an index; the binary has no names. A Scheme hygiene system must eventually print readable, non-colliding names; Nacre's lowerer resolves every reference to an index and may print `$x.3` purely for the debugging eye. Hygiene therefore costs one resolution step that the assembler was performing anyway.

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
- The lowerer emits the standard `name` section (from post-hygiene printed names) and a custom `nacre.map` section carrying the location table, so DWARF-consuming and source-map-consuming tools can both be fed later without re-architecture.

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

1. **Stage 0** – reader, expander, lowerer in TypeScript. *Implemented:* `src/nacre/nacre.ts`, one file – marks in a bigint bitset so the hygiene flip is one XOR, `defmacro` with quasiquote over a minimal meta-Lisp, the hoisting protocol for locals, inline strings pooled into data segments, printed names as debug output exactly as § 5 prescribes. `examples/fizzbuzz.nacre` expands through three macro layers into WAT that wasmtime runs; `test/nacre/` holds the golden tests, label- and local-capture cases included. Stage 0 owns its shortcuts in its header comment: macro names resolve by name alone, quasiquote does not nest, no locations yet. The stage-0 expander can also lend `defmacro` back to the host language, which has special forms and no macros.
2. **Stage 1** – the same expander, compiled to Wasm, GC AST as specified, meta-Lisp interpreted. Acceptance: it expands its own source, and stage 0 and stage 1 produce bit-identical output on the golden suite.
3. **Stage 2** – compile the meta-Lisp to `$macro-fn` functions; Binaryen IR as an alternate lowering; the browser as an expansion host, because a sandboxed expander that will not run in a `<script>` tag is leaving its best argument unused.

Most languages targeting Wasm brought their macros with them. The open seat was always the one closest to the instruction stream: a programmable assembler whose programs are its own assembly, sandboxed by the very runtime it emits for. WAT supplied the parentheses; GC supplied the cells; this document supplies the jurisprudence. What remains is secretion – layer over layer, until the irritant is a pearl.

⁂
