#!/usr/bin/env npx tsx
/**
 * Build web/playground.html — the browser as expansion host.
 *
 * The expander and the assembler are compiled by stage 0, lowered and
 * optimized by Binaryen, and embedded in the page as base64. The page
 * needs no server and phones nobody: source → expand.wasm → WAT →
 * as.wasm → binary → instantiate, all inside the tab.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compile } from './nacre.js';
import { lower } from './binaryen-lower.js';

export function buildPage(root = '.'): string {
  const p = (...x: string[]) => join(root, ...x);
  const read = (...f: string[]) => f.map((x) => readFileSync(p(x), 'utf8')).join('\n');
  const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
  const fill = (t: string, key: string, v: string) => t.replace(key, () => v);

  const wasm = (f: string) => {
    try {
      return b64(readFileSync(p(f)));
    } catch {
      return '';
    }
  };
  let page = readFileSync(p('web', 'playground.template.html'), 'utf8');
  page = fill(page, '__EXPAND_B64__', b64(lower(compile(read('src/nacre/prelude.nacre', 'src/nacre/expand.nacre')))));
  page = fill(page, '__AS_B64__', b64(lower(compile(read('src/nacre/prelude.nacre', 'src/nacre/as.nacre')))));
  page = fill(page, '__C_B64__', wasm('examples/native/crc32.wasm'));
  page = fill(page, '__RUST_B64__', wasm('examples/native/fmix.wasm'));
  page = fill(page, '__FIZZBUZZ__', JSON.stringify(read('examples/fizzbuzz.nacre')));
  page = fill(page, '__GC_AST__', JSON.stringify(read('examples/gc-ast.nacre')));
  page = fill(page, '__CLJ__', JSON.stringify(read('src/nacre/clj.nacre', 'examples/collatz.nacre')));
  page = fill(page, '__INTEROP__', JSON.stringify(read('src/nacre/clj.nacre', 'examples/interop.nacre')));
  page = fill(page, '__MANDELBROT__', JSON.stringify(read('src/nacre/clj.nacre', 'examples/mandelbrot.nacre')));
  page = fill(page, '__MANDELZOOM__', JSON.stringify(read('src/nacre/clj.nacre', 'examples/mandelzoom.nacre')));
  const out = p('web', 'playground.html');
  writeFileSync(out, page);
  return out;
}

if (process.argv[1]?.endsWith('build-web.ts')) {
  console.log(buildPage());
}
