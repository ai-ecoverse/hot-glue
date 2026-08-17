#!/usr/bin/env node
// make-envelope.mjs — fold a film and its filters into one component.
//
// The component model's name law (kebab labels, interface ids) would
// reject the film's manifest-in-imports doctrine — namespaces that
// are file paths, a protocol spelled `in!` — but the law binds only
// the outer skin: core-level instantiation arguments take arbitrary
// strings. So the envelope keeps the pathname manifest verbatim at
// the core seam, stubs the filters' WASI with the projector's own
// two-liner, lowers the six host capabilities, and lifts _start. One
// .wasm, world: `import host; export start`. The byte protocol
// crosses the seam untouched — all-scalar by construction, it is
// accidentally component-ABI-safe.
//
// Honest limits: wasmtime's CLI has no `host` instance to link, so
// running the envelope needs an embedder (wasmtime-rs, jco); and the
// `take` capability has the host write into guest memory, which the
// component model forbids by design — a component-native film would
// return list<u8> through the canonical ABI instead.
//
//   node scripts/make-envelope.mjs film.wasm envelope.wasm \
//     "examples/wav.hma=wav.wasm" "examples/rgb2y4m.hma=rgb2y4m.wasm"
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const [filmPath, outPath, ...filterArgs] = process.argv.slice(2);
const filters = new Map(filterArgs.map((a) => a.split('=')));

const print = (p) => execFileSync('wasm-tools', ['print', p], { maxBuffer: 1 << 26 }).toString();
const indent = (s, pad) => s.split('\n').map((l) => (l ? pad + l : l)).join('\n');

const { parseImports } = await import(new URL('../tools/emscripten-gates/gates-lib.mjs', import.meta.url));
const imports = parseImports(readFileSync(filmPath));
const hostFuncs = imports.filter((i) => i.mod === 'host');
const filterNs = [...new Set(imports.filter((i) => i.mod !== 'host').map((i) => i.mod))];

const filmWat = print(filmPath);
const compTy = { i32: 'u32', i64: 'u64', f32: 'float32', f64: 'float64' };

const hostDecls = hostFuncs.map(({ nm, params, results }) => {
  const ps = params.map((t, i) => `(param "p${i}" ${compTy[t]}) `).join('');
  const rs = results.length ? `(result ${compTy[results[0]]})` : '';
  return `    (export "${nm}" (func ${ps}${rs}))`;
});

const lowers = hostFuncs.map(({ nm }) =>
  `  (core func $host_${nm} (canon lower (func $host "${nm}")))`);
const hostCore = hostFuncs.map(({ nm }) => `    (export "${nm}" (func $host_${nm}))`);

const filterMods = filterNs.map((ns, i) => {
  const path = filters.get(ns);
  if (!path) throw new Error(`no wasm given for filter namespace ${ns}`);
  return {
    ns,
    mod: `  (core module $f${i}\n${indent(print(path).replace(/^\(module/, '').replace(/\)\s*$/, ''), '  ')}  )`,
    inst: `  (core instance $f${i}i (instantiate $f${i} (with "wasi_snapshot_preview1" (instance $stubi))))`,
    with: `      (with "${ns}" (instance $f${i}i))`,
  };
});

const wat = `(component
  ;; one film, its filters inside, the pathname manifest intact at
  ;; the core seam — only the outer skin speaks component
  (import "host" (instance $host
${hostDecls.join('\n')}
  ))
  ;; the filters' WASI is the projector's stub, two lines of it
  (core module $stub
    (func (export "fd_read") (param i32 i32 i32 i32) (result i32) i32.const 8)
    (func (export "fd_write") (param i32 i32 i32 i32) (result i32) i32.const 8))
  (core instance $stubi (instantiate $stub))
${filterMods.map((f) => f.mod).join('\n')}
${filterMods.map((f) => f.inst).join('\n')}
${lowers.join('\n')}
  (core instance $hostcore
${hostCore.join('\n')})
  (core module $film
${indent(filmWat.replace(/^\(module/, '').replace(/\)\s*$/, ''), '  ')}  )
  (core instance $filmi (instantiate $film
      (with "host" (instance $hostcore))
${filterMods.map((f) => f.with).join('\n')}))
  (func $start (canon lift (core func $filmi "_start")))
  (export "start" (func $start))
)
`;

writeFileSync(outPath.replace(/\.wasm$/, '.wat'), wat);
const bin = execFileSync('wasm-tools', ['parse', outPath.replace(/\.wasm$/, '.wat')], { maxBuffer: 1 << 26 });
writeFileSync(outPath, bin);
execFileSync('wasm-tools', ['validate', outPath]);
console.log(`${outPath}: ${bin.length} bytes, validates as a component`);
