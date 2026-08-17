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
import { compile, loadSource } from './bootstrap.js';
import { lower } from './binaryen-lower.js';

export function buildPage(root = '.'): string {
  const p = (...x: string[]) => join(root, ...x);
  const read = (...f: string[]) => loadSource(f.map((x) => p(x)));
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
  page = fill(page, '__EXPAND_B64__', b64(lower(compile(read('src/hotglue/expand.hma')))));
  page = fill(page, '__AS_B64__', b64(lower(compile(read('src/hotglue/as.hma')))));
  page = fill(page, '__GLUE_B64__', b64(lower(compile(read('src/hotglue/hotglue.hma')))));
  page = fill(page, '__C_B64__', wasm('examples/native/crc32.wasm'));
  page = fill(page, '__RUST_B64__', wasm('examples/native/fmix.wasm'));
  // the lookup path, embedded: (use …) in the tab resolves against these
  const raw = (f: string) => readFileSync(p(f), 'utf8');
  page = fill(
    page,
    '__LIBS__',
    JSON.stringify({
      'prelude.hma': raw('src/hotglue/prelude.hma'),
      'clj.hma': raw('src/hotglue/clj.hma'),
    }),
  );
  // examples arrive verbatim — their (use …) lines resolve in the tab
  page = fill(page, '__FIZZBUZZ__', JSON.stringify(raw('examples/fizzbuzz.hma')));
  page = fill(page, '__GC_AST__', JSON.stringify(raw('examples/gc-ast.hma')));
  page = fill(page, '__CLJ__', JSON.stringify(raw('examples/collatz.hma')));
  page = fill(page, '__INTEROP__', JSON.stringify(raw('examples/interop.hma')));
  page = fill(page, '__MANDELBROT__', JSON.stringify(raw('examples/mandelbrot.hma')));
  page = fill(page, '__MANDELZOOM__', JSON.stringify(raw('examples/mandelzoom.hma')));
  page = fill(page, '__DEEPZOOM__', JSON.stringify(raw('examples/deepzoom.hma')));
  page = fill(page, '__GPT__', JSON.stringify(raw('examples/gpt.hma')));
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
