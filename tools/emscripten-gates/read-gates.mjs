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
import {
  parseImports, findImportObject, functionSource, classify, SERVABLE,
} from './gates-lib.mjs';

const [wasmPath, jsPath] = process.argv.slice(2);

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
