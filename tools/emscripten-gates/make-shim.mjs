#!/usr/bin/env node
// make-shim.mjs — serve the gates without the glue.
//
// The ledger (read-gates.mjs) told us what each minified gate does;
// this tool acts on it. It emits a WAT module — in the Hot Glue
// subset, assembled by as.hma like everything else here — that
// exports every gate an Emscripten binary imports, implementing the
// ones whose JS bodies translate mechanically:
//
//   - empty bodies and constant returns become nops and consts
//   - Ka.copyWithin(a,b,b+c) is memcpy_big: one memory.copy
//   - the Date.now family becomes WASI clock_time_get arithmetic
//   - the fd_write/read/close gates ARE WASI calls already — the
//     Emscripten iovec walk has WASI's exact layout and semantics,
//     so they forward straight through
//   - exitRuntime forwards to proc_exit, abort to unreachable
//
// Everything else exports a loud stub: it reports its gate id
// through host.miss and traps. Run the binary, read the miss,
// translate that gate, repeat — the porting loop is empirical, not
// speculative. The sidecar JSON carries the memory descriptor, the
// export map (public name → minified), and each gate's disposition,
// which is everything a thin host needs (see thin-host.mjs).
//
// The shim imports the module's own (shared) memory, scribbles only
// in the 8 bytes at address 64 — below Emscripten's GLOBAL_BASE of
// 1024, an address range its layouts leave unused — and speaks WASI
// for time, I/O, and exit.
//
//   node tools/emscripten-gates/make-shim.mjs core.wasm core.js outdir/
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseImports, findImportObject, functionSource, resolveSource,
  memoryDescriptor, exportMap,
} from './gates-lib.mjs';

const [wasmPath, jsPath, outDir = '.'] = process.argv.slice(2);
const js = readFileSync(jsPath, 'utf8');
const imports = parseImports(readFileSync(wasmPath));
const namespaces = [...new Set(imports.map((i) => i.mod))];
const found = findImportObject(js, namespaces);
const lookup = (mod, nm) => (found.direct ? found.direct[nm] : found.perNs?.[mod]?.[nm]);

const SCRATCH = 64; // 8 bytes of shim scratch, below GLOBAL_BASE
const STATE_BASE = 80; // glue-state slots (4 bytes each) start here

// Emscripten glue keeps runtime state in JS vars that gates read and
// write (`function(){return rb|0}` / `function(a){Aa=a|0}` — thread
// pointer, tempRet0, …). We keep that state in the guest's own
// memory instead: each var gets a 4-byte slot below GLOBAL_BASE, the
// gates become single loads and stores, and the boot ritual fills
// the slots it creates.
const stateSlots = new Map();
const stateSlot = (name) => {
  if (!stateSlots.has(name)) stateSlots.set(name, STATE_BASE + 4 * stateSlots.size);
  return stateSlots.get(name);
};
const READER = /^function[\w$]*\(\)\{return([A-Za-z$_][\w$]*)\|0\}$/;
const WRITER = /^function[\w$]*\(([a-z])\)\{([A-Za-z$_][\w$]*)=\1\|0\}$/;

// ---------------------------------------------------- the translators
// each returns a WAT body (string) or null; `one` is the resolved
// source with all whitespace removed, `params`/`results` the wasm sig
const L = (i) => `(local.get $p${i})`;
const NS = 1000000000n;

const RULES = [
  {
    kind: 'empty',
    match: ({ one }) => /^function[\w$]*\([^)]*\)\{\}$/.test(one),
    body: ({ results }) => (results.length ? '(i32.const 0)' : '(nop)'),
  },
  {
    kind: 'const',
    match: ({ one }) => /^function[\w$]*\([^)]*\)\{return(!0|!1|-?\d+)(\|0)?;?\}$/.exec(one),
    body: ({ m, results }) => {
      const v = m[1] === '!0' ? 1 : m[1] === '!1' ? 0 : Number(m[1]);
      return `(${results[0] ?? 'i32'}.const ${v})`;
    },
  },
  {
    kind: 'shared-array-buffer-probe',
    match: ({ one }) => one.includes('typeofSharedArrayBuffer'),
    body: () => '(i32.const 1)', // the memory we import IS shared
  },
  {
    kind: 'state-reader',
    match: ({ one }) => READER.exec(one),
    body: ({ m }) => `(i32.load (i32.const ${stateSlot(m[1])}))`,
  },
  {
    kind: 'state-writer',
    match: ({ one }) => WRITER.exec(one),
    body: ({ m }) => `(i32.store (i32.const ${stateSlot(m[2])}) (local.get $p0))`,
  },
  {
    kind: 'memcpy-big',
    match: ({ one }) => /copyWithin\(a,b,b\+c\)/.test(one),
    body: ({ results }) =>
      `(memory.copy ${L(0)} ${L(1)} ${L(2)})${results.length ? ' (i32.const 0)' : ''}`,
  },
  {
    kind: 'gettimeofday',
    match: ({ one }) => /Date\.now\(\);D\[a>>2\]=b\/1E3\|0/.test(one),
    body: () => [
      `(drop (call $clock_time_get (i32.const 0) (i64.const 1000) (i32.const ${SCRATCH})))`,
      `(i32.store ${L(0)} (i32.wrap_i64 (i64.div_u (i64.load (i32.const ${SCRATCH})) (i64.const ${NS}))))`,
      `(i32.store (i32.add ${L(0)} (i32.const 4))`,
      `  (i32.wrap_i64 (i64.div_u (i64.rem_u (i64.load (i32.const ${SCRATCH})) (i64.const ${NS})) (i64.const 1000))))`,
      '(i32.const 0)',
    ].join('\n    '),
  },
  {
    kind: 'clock-gettime',
    match: ({ one }) => /1===a\|\|4===a/.test(one) && /Date\.now/.test(one),
    body: () => [
      '(drop (call $clock_time_get',
      `  (if (result i32) (i32.eqz ${L(0)}) (then (i32.const 0)) (else (i32.const 1)))`,
      `  (i64.const 1) (i32.const ${SCRATCH})))`,
      `(i32.store ${L(1)} (i32.wrap_i64 (i64.div_u (i64.load (i32.const ${SCRATCH})) (i64.const ${NS}))))`,
      `(i32.store (i32.add ${L(1)} (i32.const 4))`,
      `  (i32.wrap_i64 (i64.rem_u (i64.load (i32.const ${SCRATCH})) (i64.const ${NS}))))`,
      '(i32.const 0)',
    ].join('\n    '),
  },
  {
    kind: 'monotonic-ms',
    match: ({ one }) => /return1E3\*\(Date\.now\(\)-/.test(one),
    body: () => [
      `(drop (call $clock_time_get (i32.const 1) (i64.const 1000000) (i32.const ${SCRATCH})))`,
      `(i32.wrap_i64 (i64.div_u (i64.load (i32.const ${SCRATCH})) (i64.const 1000000)))`,
    ].join('\n    '),
  },
  {
    kind: 'now-ms-f64',
    match: ({ one, results }) => /process\.hrtime|performance\.now/.test(one) && results[0] === 'f64',
    body: () => [
      `(drop (call $clock_time_get (i32.const 1) (i64.const 1000) (i32.const ${SCRATCH})))`,
      `(f64.div (f64.convert_i64_u (i64.load (i32.const ${SCRATCH}))) (f64.const 1000000))`,
    ].join('\n    '),
  },
  {
    kind: 'environ-sizes',
    match: ({ one }) => /^function[\w$]*\(a,b\)\{varc=[\w$]+\(\);D\[a>>2\]=c\.length;/.test(one),
    body: () => [
      `(i32.store ${L(0)} (i32.const 0))`, // no environment variables
      `(i32.store ${L(1)} (i32.const 0))`,
      '(i32.const 0)',
    ].join('\n    '),
  },
  {
    kind: 'environ-get',
    match: ({ one }) => /\[a\+4\*e>>2\]=/.test(one),
    body: () => '(i32.const 0)', // sizes said zero: nothing to write
  },
  {
    kind: 'fd-write',
    match: ({ one, params }) => /N\.write/.test(one) && params.length === 4,
    body: () => `(call $fd_write ${L(0)} ${L(1)} ${L(2)} ${L(3)})`,
  },
  {
    kind: 'fd-read',
    match: ({ one, params }) => /N\.read/.test(one) && params.length === 4 && /8\*/.test(one),
    body: () => `(call $fd_read ${L(0)} ${L(1)} ${L(2)} ${L(3)})`,
  },
  {
    kind: 'fd-close',
    match: ({ one, params }) => /N\.close/.test(one) && params.length === 1,
    body: () => `(call $fd_close ${L(0)})`,
  },
  {
    kind: 'exit',
    match: ({ one }) => /noExitRuntime/.test(one) && /onExit/.test(one),
    body: ({ results }) => `(call $proc_exit ${L(0)})${results.length ? ' (i32.const 0)' : ''}`,
  },
  {
    kind: 'abort',
    match: ({ one }) => /RuntimeError\("abort/.test(one) || /^function[\w$]*\(\)\{u\(\)\}$/.test(one),
    body: () => '(unreachable)',
  },
  {
    kind: 'flush',
    match: ({ one }) => /^function[\w$]*\(\)\{[A-Za-z$_][\w$]*\.flush\(\)\}$/.test(one),
    body: () => '(nop)',
  },
];

// some gates are boot ritual, not steady-state ABI: they call back
// into the module's own exports (malloc, thread init) mid-ctors, so
// no pre-instantiation wasm shim can serve them. These the thin host
// serves generically, late-bound; the sidecar names their kind.
function methodBody(one) {
  // function(){X.y()} — resolve the method y on some glue object
  const m = /^function[\w$]*\(\)\{[A-Za-z$_][\w$]*\.([\w$]+)\(\)\}$/.exec(one ?? '');
  if (!m) return null;
  const d = js.search(new RegExp(`\\b${m[1].replace(/\$/g, '\\$')}\\s*:\\s*function\\s*\\(`));
  if (d < 0) return null;
  let p = js.indexOf('{', d), depth = 0, q = p;
  for (; q < js.length; q++) {
    if (js[q] === '{') depth++;
    if (js[q] === '}' && --depth === 0) break;
  }
  return js.slice(p, q + 1).replace(/\s+/g, '');
}
let pthreadStateVars = null; // set when pthread-main-init is found
const HOST_RULES = [
  {
    kind: 'pthread-main-init',
    match: (ctx) => {
      const b = methodBody(ctx.one);
      if (!(b && /\(232\)/.test(b) && /Atomics\.store/.test(b) && /,42\)/.test(b))) return false;
      // the init ends by calling the glue's state setter —
      // `ub(L.xf,!oa,1)` where ub assigns its params to state vars
      // in order (thread ptr, is-main, can-block). Recover the var
      // names so the host ritual can fill their slots.
      const call = /([A-Za-z$_][\w$]*)\([A-Za-z$_][\w$]*\.[\w$]+,![\w$]+,1\)/.exec(b);
      if (call) {
        const src = functionSource(js, call[1])?.replace(/\s+/g, '');
        const vars = [...(src ?? '').matchAll(/([A-Za-z$_][\w$]*)=[a-z]\|0/g)].map((v) => v[1]);
        if (vars.length === 3) pthreadStateVars = vars;
      }
      return true;
    },
  },
  {
    // defer a call through the module's own table until the runtime
    // is up — Emscripten queues these during ctors, the host flushes
    // the queue before main
    kind: 'deferred-table-call',
    match: ({ one }) => /\.push\(function\(\)\{[\w$]+\.get\(a\)\(b\)\}\)/.test(one),
  },
  {
    // atexit: remember (fn, arg), call through the table after main
    kind: 'atexit-table-call',
    match: ({ one }) => /\.unshift\(\{[\w$]+:a,[\w$]+:b\}\)/.test(one),
  },
];

// ------------------------------------------------------ the emission
const gates = imports.filter((i) => i.kind === 'func');
const nonFunc = imports.filter((i) => i.kind !== 'func');
if (nonFunc.some((i) => i.kind !== 'memory'))
  console.error(`note: non-memory non-func imports present: ${nonFunc.map((i) => `${i.mod}.${i.nm}:${i.kind}`).join(' ')}`);

const mem = memoryDescriptor(js);
const sidecar = {
  memory: mem,
  exports: exportMap(js),
  gates: {},
  hostGates: {},
  misses: {},
};

const funcs = [];
const shimGates = [];
let missId = 0;
for (const g of gates) {
  const entry = lookup(g.mod, g.nm);
  const src = resolveSource(js, entry);
  const one = src ? src.replace(/\s+/g, '') : null;
  const ctx = { one, params: g.params, results: g.results };
  const hosted = one && HOST_RULES.find((r) => r.match(ctx));
  if (hosted) {
    sidecar.gates[`${g.mod}.${g.nm}`] = `host:${hosted.kind}`;
    sidecar.hostGates[g.nm] = hosted.kind;
    continue;
  }
  let done = null;
  if (one)
    for (const rule of RULES) {
      const m = rule.match(ctx);
      if (m) { done = { kind: rule.kind, body: rule.body({ ...ctx, m }) }; break; }
    }
  if (!done) {
    const id = missId++;
    sidecar.misses[id] = `${g.mod}.${g.nm}`;
    done = { kind: 'stub', body: `(call $miss (i32.const ${id}))\n    (unreachable)` };
  }
  sidecar.gates[`${g.mod}.${g.nm}`] = done.kind;
  const params = g.params.map((t, i) => `(param $p${i} ${t})`).join(' ');
  const results = g.results.length ? ` (result ${g.results.join(' ')})` : '';
  shimGates.push(g);
  funcs.push(`  (func (export "${g.nm}") ${params}${results}\n    ${done.body})`);
}

// as.hma's implicit signatures are all-i32 (packed by count), so a
// module holding an i64-bearing import must declare explicit types —
// and once any (type …) exists, every function needs its (type $t)
const typeIds = new Map();
const typeRef = (params, results) => {
  const key = `(func${params.length ? ` (param ${params.join(' ')})` : ''}${results.length ? ` (result ${results.join(' ')})` : ''})`;
  if (!typeIds.has(key)) typeIds.set(key, `$t${typeIds.size}`);
  return typeIds.get(key);
};

const wasiImports = [
  ['clock_time_get', '$clock_time_get', ['i32', 'i64', 'i32'], ['i32']],
  ['fd_write', '$fd_write', ['i32', 'i32', 'i32', 'i32'], ['i32']],
  ['fd_read', '$fd_read', ['i32', 'i32', 'i32', 'i32'], ['i32']],
  ['fd_close', '$fd_close', ['i32'], ['i32']],
  ['proc_exit', '$proc_exit', ['i32'], []],
].map(([nm, sym, ps, rs]) =>
  `  (import "wasi_snapshot_preview1" "${nm}" (func ${sym} (type ${typeRef(ps, rs)})))`);
const missImport = `  (import "host" "miss" (func $miss (type ${typeRef(['i32'], [])})))`;

const typedFuncs = funcs.map((f, i) => {
  const g = shimGates[i];
  return f.replace('(func (export', `(func (type ${typeRef(g.params, g.results)}) (export`);
});
const typeDecls = [...typeIds.entries()].map(([key, id]) => `  (type ${id} ${key})`);

const limits = mem.shared ? `shared ${mem.pages} ${mem.pages}` : `${mem.pages}`;
const wat = `(module
  ;; generated by make-shim.mjs from ${wasmPath.split('/').pop()} +
  ;; its glue — the gates Emscripten opened for JavaScript, served
  ;; without it. Scratch: 8 bytes at ${SCRATCH}, below GLOBAL_BASE.
${typeDecls.join('\n')}
${wasiImports.join('\n')}
${missImport}
  (import "env" "memory" (memory ${limits}))
${typedFuncs.join('\n')}
)
`;

sidecar.stateSlots = Object.fromEntries(stateSlots);
sidecar.pthreadStateVars = pthreadStateVars;

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'shim.wat'), wat);
writeFileSync(join(outDir, 'shim.json'), JSON.stringify(sidecar, null, 2));

const kinds = {};
for (const k of Object.values(sidecar.gates)) kinds[k] = (kinds[k] ?? 0) + 1;
console.log(`${gates.length} gates → ${join(outDir, 'shim.wat')}`);
console.log(Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => `  ${k}: ${n}`).join('\n'));
console.log(`memory: ${mem.pages} pages${mem.shared ? ', shared' : ''}; exports mapped: ${Object.keys(sidecar.exports).length}`);
