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
import { gzipSync } from 'node:zlib';
import { compile } from './bootstrap.js';
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
  page = fill(page, '__EXPAND_B64__', b64(lower(compile(read('src/hotglue/prelude.hma', 'src/hotglue/expand.hma')))));
  page = fill(page, '__AS_B64__', b64(lower(compile(read('src/hotglue/prelude.hma', 'src/hotglue/as.hma')))));
  page = fill(page, '__C_B64__', wasm('examples/native/crc32.wasm'));
  page = fill(page, '__RUST_B64__', wasm('examples/native/fmix.wasm'));
  page = fill(page, '__FIZZBUZZ__', JSON.stringify(read('examples/fizzbuzz.hma')));
  page = fill(page, '__GC_AST__', JSON.stringify(read('examples/gc-ast.hma')));
  page = fill(page, '__CLJ__', JSON.stringify(read('src/hotglue/clj.hma', 'examples/collatz.hma')));
  page = fill(page, '__INTEROP__', JSON.stringify(read('src/hotglue/clj.hma', 'examples/interop.hma')));
  page = fill(page, '__MANDELBROT__', JSON.stringify(read('src/hotglue/clj.hma', 'examples/mandelbrot.hma')));
  page = fill(page, '__MANDELZOOM__', JSON.stringify(read('src/hotglue/clj.hma', 'examples/mandelzoom.hma')));
  page = fill(page, '__DEEPZOOM__', JSON.stringify(read('src/hotglue/clj.hma', 'examples/deepzoom.hma')));
  page = fill(page, '__GPT__', JSON.stringify(read('src/hotglue/clj.hma', 'examples/gpt.hma')));
  // the oyster's weights ride along gzipped; the tab inflates them itself
  let oyster = '';
  try {
    oyster = b64(gzipSync(readFileSync(p('examples', 'oyster.npt')), { level: 9 }));
  } catch {
    /* no weights trained yet — the gpt example will say so */
  }
  page = fill(page, '__OYSTER_GZ_B64__', oyster);
  const out = p('web', 'playground.html');
  writeFileSync(out, page);
  return out;
}

if (process.argv[1]?.endsWith('build-web.ts')) {
  console.log(buildPage());
}
