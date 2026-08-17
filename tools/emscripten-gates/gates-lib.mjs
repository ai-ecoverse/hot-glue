// gates-lib.mjs — the shared craft of reading Emscripten's gates.
//
// Used by read-gates.mjs (the ledger) and make-shim.mjs (the shim
// generator). The wasm import section is the authority on shape; the
// JS glue is the authority on meaning; both parsers live here.

// ------------------------------------------------ wasm import section
export function parseImports(buf) {
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
            mod, nm, kind: 'func',
            params: t.ps.map((x) => vt[x]), results: t.rs.map((x) => vt[x]),
            sig: `(${t.ps.map((x) => vt[x]).join(' ')}) -> (${t.rs.map((x) => vt[x]).join(' ')})`,
          });
        } else {
          // memory/table/global imports: skip their descriptors coarsely
          if (kind === 1) { u8(); const f = u8(); leb(); if (f & 1) leb(); }
          if (kind === 2) { const f = u8(); leb(); if (f & 1) leb(); }
          if (kind === 3) { u8(); u8(); }
          imports.push({ mod, nm, kind: ['func', 'table', 'memory', 'global'][kind], sig: ['func', 'table', 'memory', 'global'][kind] });
        }
      }
      break; // nothing after imports interests us
    }
    p = end;
  }
  return imports;
}

// -------------------------------------------------- js glue analysis
export function braceSpan(js, open) {
  let depth = 0, p = open;
  for (; p < js.length; p++) {
    if (js[p] === '{') depth++;
    if (js[p] === '}' && --depth === 0) break;
  }
  return js.slice(open + 1, p);
}

export function entriesOf(body) {
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
      // the value may be a larger expression (`Ca||f.wasmMemory`) —
      // skip to the next comma at bracket depth zero
      let depth = 0;
      for (; p < body.length; p++) {
        const ch = body[p];
        if (ch === '(' || ch === '{' || ch === '[') depth++;
        if (ch === ')' || ch === '}' || ch === ']') depth--;
        if (ch === ',' && depth === 0) break;
      }
    }
  }
  return map;
}

export function findImportObject(js, namespaces) {
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

export function functionSource(js, ident) {
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

export const CLASSES = [
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

export function classify(src) {
  if (!src) return 'unresolved';
  for (const [re, label] of CLASSES) if (re.test(src)) return label;
  if (src.length < 90) return 'trivial';
  return 'other';
}

// WASI-mappable or host-trivial: the classes a JS-free host can serve
// invoke-trampolines are stack-save + indirect call + longjmp catch:
// implementable as a generated wasm-side shim against the module's own
// table and setThrew export — no JS semantics involved
export const SERVABLE = new Set([
  'syscall', 'stdio', 'abort', 'clock', 'random', 'memory-growth',
  'environ', 'exit', 'temp-ret', 'trivial', 'timezone', 'strftime',
  'invoke-trampoline',
]);

// ------------------------------------------- glue facts beyond gates
export function memoryDescriptor(js) {
  // Va=f.INITIAL_MEMORY||1073741824 …
  // new WebAssembly.Memory({initial:Va/65536,maximum:Va/65536,shared:!0})
  const m = js.match(/[A-Za-z$_][\w$]*\.INITIAL_MEMORY\s*\|\|\s*(\d+)/);
  const shared = /new WebAssembly\.Memory\(\{[^}]*shared\s*:\s*!0/.test(js);
  const bytes = m ? Number(m[1]) : 16777216;
  return { pages: bytes / 65536, shared };
}

export function exportMap(js) {
  // ne=f._main=function(){return(ne=f._main=f.asm.$d).apply(…)} — the
  // public name and the minified export meet inside the lazy binder
  const map = {};
  for (const m of js.matchAll(/[A-Za-z$_][\w$]*\.(_[\w$]+|___?\w+)\s*=\s*[A-Za-z$_][\w$]*\.asm\.([\w$]+)/g))
    map[m[1]] ??= m[2];
  // the table and unprefixed runtime exports bind as IDENT=OBJ.asm.KEY
  for (const m of js.matchAll(/([A-Za-z$_][\w$]*)\s*=\s*[A-Za-z$_][\w$]*\.asm\.([\w$]+)/g))
    map[m[1]] ??= m[2];
  return map;
}

// chase pure forwards (`function(a,b){return F(a,b)}`) to their target
export function resolveSource(js, entry, depth = 4) {
  let src = entry?.inline ?? (entry?.ident ? functionSource(js, entry.ident) : null);
  while (src && depth-- > 0) {
    const one = src.replace(/\s+/g, '');
    const fwd = one.match(/^function[\w$]*\(([^)]*)\)\{(?:return)?([A-Za-z$_][\w$]*)\(([^)]*)\)(\|0)?;?\}$/);
    if (!fwd) break;
    const [, params, target, args] = fwd;
    if (args !== params && args !== '' && !params.startsWith(args)) break;
    const next = functionSource(js, target);
    if (!next) break;
    src = next;
  }
  return src;
}
