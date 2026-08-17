#!/usr/bin/env node
// read-gates.mjs — read the gates Emscripten opened for JavaScript.
//
// An Emscripten module imports a minified alphabet ("a"."b", "a"."c",
// …) that only its own JS glue understands. But the glue is text, and
// the mapping is right there: parse the import object literal, chase
// each identifier to its function body, and the ABI stops being
// secret. Pair that with the .wasm import section (parsed here from
// the binary, for exact type signatures) and you get a ledger of
// every gate: name, signature, what the JS does behind it, and
// whether a JS-free host could supply it.
//
//   node tools/emscripten-gates/read-gates.mjs \
//     node_modules/@ffmpeg/core/dist/ffmpeg-core.wasm \
//     node_modules/@ffmpeg/core/dist/ffmpeg-core.js
import { readFileSync } from 'node:fs';

const [wasmPath, jsPath] = process.argv.slice(2);

// ------------------------------------------------ wasm import section
function parseImports(buf) {
  let p = 8; // skip magic + version
  const u8 = () => buf[p++];
  const leb = () => {
    let r = 0, s = 0, b;
    do { b = u8(); r |= (b & 127) << s; s += 7; } while (b & 128);
    return r >>> 0;
  };
  const name = () => {
    const n = leb(), s = buf.subarray(p, p + n).toString('utf8');
    p += n;
    return s;
  };
  const types = [];
  const imports = [];
  while (p < buf.length) {
    const id = u8(), size = leb(), end = p + size;
    if (id === 1) {
      const n = leb();
      for (let i = 0; i < n; i++) {
        u8(); // 0x60
        const np = leb(), ps = [];
        for (let j = 0; j < np; j++) ps.push(u8());
        const nr = leb(), rs = [];
        for (let j = 0; j < nr; j++) rs.push(u8());
        types.push({ ps, rs });
      }
    } else if (id === 2) {
      const vt = { 127: 'i32', 126: 'i64', 125: 'f32', 124: 'f64', 111: 'externref', 112: 'funcref' };
      const n = leb();
      for (let i = 0; i < n; i++) {
        const mod = name(), nm = name(), kind = u8();
        if (kind === 0) {
          const t = types[leb()];
          imports.push({
            mod, nm,
            sig: `(${t.ps.map((x) => vt[x]).join(' ')}) -> (${t.rs.map((x) => vt[x]).join(' ')})`,
          });
        } else {
          // memory/table/global imports: skip their descriptors coarsely
          if (kind === 1) { u8(); const f = u8(); leb(); if (f & 1) leb(); }
          if (kind === 2) { const f = u8(); leb(); if (f & 1) leb(); }
          if (kind === 3) { u8(); u8(); }
          imports.push({ mod, nm, sig: ['func', 'table', 'memory', 'global'][kind] });
        }
      }
      break; // nothing after imports interests us
    }
    p = end;
  }
  return imports;
}

// -------------------------------------------------- js glue analysis
function braceSpan(js, open) {
  let depth = 0, p = open;
  for (; p < js.length; p++) {
    if (js[p] === '{') depth++;
    if (js[p] === '}' && --depth === 0) break;
  }
  return js.slice(open + 1, p);
}

function entriesOf(body) {
  // a real little scanner: entries are `name:IDENT` or
  // `name:function(...){...}` (closure inlines most of them) —
  // values must be brace-matched, since bodies contain commas
  const map = {};
  let p = 0;
  const ws = () => { while (p < body.length && /\s/.test(body[p])) p++; };
  while (p < body.length) {
    ws();
    if (body[p] === ',') { p++; continue; }
    let key = '';
    if (body[p] === '"') {
      const e = body.indexOf('"', p + 1);
      key = body.slice(p + 1, e);
      p = e + 1;
    } else {
      const m = /^[A-Za-z0-9_$]+/.exec(body.slice(p));
      if (!m) break;
      key = m[0];
      p += key.length;
    }
    ws();
    if (body[p] !== ':') break;
    p++;
    ws();
    if (body.startsWith('function', p)) {
      const open = body.indexOf('{', p);
      let depth = 0, q = open;
      for (; q < body.length; q++) {
        if (body[q] === '{') depth++;
        if (body[q] === '}' && --depth === 0) break;
      }
      map[key] = { inline: body.slice(p, q + 1) };
      p = q + 1;
    } else {
      const m = /^[A-Za-z0-9_$.]+/.exec(body.slice(p));
      if (!m) break;
      map[key] = { ident: m[0] };
      p += m[0].length;
    }
  }
  return map;
}

function findImportObject(js, namespaces) {
  // unminified/newer emscripten: one flat object
  const flat = js.match(/var\s+(asmLibraryArg|wasmImports)\s*=\s*\{/);
  if (flat) return { direct: entriesOf(braceSpan(js, js.indexOf('{', flat.index))) };
  // closure-minified: the instantiate object maps NS -> object var,
  // e.g. `var d={a:Ge}` — chase each namespace to its object literal
  const perNs = {};
  for (const ns of namespaces) {
    const re = new RegExp(`[{,]\\s*"?${ns}"?\\s*:\\s*([A-Za-z$_][\\w$]*)\\s*[},]`, 'g');
    let m, ident = null;
    while ((m = re.exec(js))) {
      // the right one is a var holding an object literal of functions
      // declarations appear as `var X={`, `,X={`, or `;X={`
      const decl = js.match(new RegExp(`(?:var\\s+|[,;(])${m[1].replace(/\$/g, '\\$')}\\s*=\\s*\\{`));
      if (decl) { ident = { name: m[1], at: js.indexOf('{', decl.index) }; break; }
    }
    if (ident) perNs[ns] = entriesOf(braceSpan(js, ident.at));
  }
  return { perNs };
}

function functionSource(js, ident) {
  // function IDENT(...){...} | var IDENT=(...)=>... | IDENT=function(...){...}
  const decl = new RegExp(`function\\s+${ident.replace(/\$/g, '\\$')}\\s*\\(`);
  let m = js.match(decl);
  let p;
  if (m) {
    p = js.indexOf('{', m.index + m[0].length - 1);
  } else {
    const asn = new RegExp(`(?:var\\s+)?${ident.replace(/\$/g, '\\$')}\\s*=\\s*(?:function\\s*)?\\(`);
    m = js.match(asn);
    if (!m) return null;
    const arrow = js.indexOf('=>', m.index);
    const brace = js.indexOf('{', m.index);
    if (arrow >= 0 && (brace < 0 || arrow < brace + 3)) {
      // arrow: body to matching brace or expression to next ; at depth 0
      p = js.indexOf('{', arrow);
      if (p < 0 || p > arrow + 3) {
        const semi = js.indexOf(';', arrow);
        return js.slice(m.index, semi + 1);
      }
    } else {
      p = brace;
    }
  }
  if (p == null || p < 0) return null;
  let depth = 0, q = p;
  for (; q < js.length; q++) {
    if (js[q] === '{') depth++;
    if (js[q] === '}' && --depth === 0) break;
  }
  return js.slice(m.index, q + 1);
}

const CLASSES = [
  [/G\.get\(|getWasmTableEntry|wasmTable\.get/, 'invoke-trampoline'],
  [/___syscall|SYSCALLS/, 'syscall'],
  [/\bfd_(write|read|close|seek|fdstat)|printChar|flush/, 'stdio'],
  [/abort\(|abortOnCannotGrowMemory|unreachable/, 'abort'],
  [/Date\.now|performance\.now|clock_gettime|_time\b|gettimeofday/, 'clock'],
  [/Math\.random|getRandomValues|randomFill/, 'random'],
  [/growMemory|resize_heap|updateMemoryViews|wasmMemory\.grow/, 'memory-growth'],
  [/throw\b.*(longjmp|Infinity|exception)|invoke_|setThrew|Longjmp/, 'exceptions-longjmp'],
  [/tempRet0/, 'temp-ret'],
  [/environ|getenv/, 'environ'],
  [/dlopen|dlsym|dynamic/i, 'dynamic-linking'],
  [/pthread|Atomics|worker/i, 'threads'],
  [/tzset|localtime|mktime/, 'timezone'],
  [/exit\(|proc_exit/, 'exit'],
  [/strftime/, 'strftime'],
];

function classify(src) {
  if (!src) return 'unresolved';
  for (const [re, label] of CLASSES) if (re.test(src)) return label;
  if (src.length < 90) return 'trivial';
  return 'other';
}

// WASI-mappable or host-trivial: the classes a JS-free host can serve
// invoke-trampolines are stack-save + indirect call + longjmp catch:
// implementable as a generated wasm-side shim against the module's own
// table and setThrew export — no JS semantics involved
const SERVABLE = new Set([
  'syscall', 'stdio', 'abort', 'clock', 'random', 'memory-growth',
  'environ', 'exit', 'temp-ret', 'trivial', 'timezone', 'strftime',
  'invoke-trampoline',
]);

const imports = parseImports(readFileSync(wasmPath));
const js = readFileSync(jsPath, 'utf8');
const namespaces = [...new Set(imports.map((i) => i.mod))];
const found = findImportObject(js, namespaces);
const lookup = (mod, nm) => (found.direct ? found.direct[nm] : found.perNs?.[mod]?.[nm]);

const rows = imports.map(({ mod, nm, sig }) => {
  const entry = lookup(mod, nm);
  const src = entry?.inline ?? (entry?.ident ? functionSource(js, entry.ident) : null);
  const cls = classify(src);
  return { gate: `${mod}.${nm}`, sig, ident: entry?.ident ?? (entry?.inline ? '(inline)' : '?'), cls, src };
});

const byClass = {};
for (const r of rows) (byClass[r.cls] ??= []).push(r);

console.log(`# gates of ${wasmPath.split('/').pop()}`);
console.log(`${imports.length} imports across namespaces: ${namespaces.join(", ")}\n`);
for (const [cls, rs] of Object.entries(byClass).sort((a, b) => b[1].length - a[1].length)) {
  const servable = SERVABLE.has(cls) ? 'servable without JS' : cls === 'unresolved' ? 'unmapped' : 'needs thought';
  console.log(`## ${cls} — ${rs.length} gates (${servable})`);
  for (const r of rs.slice(0, process.env.VERBOSE ? 1000 : 4))
    console.log(`  ${r.gate} ${r.sig}  ← ${r.ident}${r.src ? ': ' + r.src.replace(/\s+/g, ' ').slice(0, 100) : ''}`);
  if (!process.env.VERBOSE && rs.length > 4) console.log(`  … ${rs.length - 4} more`);
  console.log();
}
const servable = rows.filter((r) => SERVABLE.has(r.cls)).length;
console.log(`verdict: ${servable}/${rows.length} gates servable by a JS-free host as classified;`);
console.log(`the rest is exceptions/longjmp plumbing, threads, or unmapped entries — read those by hand.`);
