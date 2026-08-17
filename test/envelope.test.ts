import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile, loadSource } from '../src/bootstrap.js';

function probe(bins: string[], flag: string): string | null {
  for (const bin of bins) {
    try {
      execFileSync(bin, [flag], { stdio: 'pipe' });
      return bin;
    } catch {
      /* keep looking */
    }
  }
  return null;
}
const runtime = probe(['wasmtime', join(process.env.HOME ?? '', '.local/bin/wasmtime')], '--version');
const wasmTools = probe(['wasm-tools', join(process.env.HOME ?? '', '.cargo/bin/wasm-tools')], '--version');

describe('the component envelope: one .wasm for film and filters', () => {
  it.skipIf(!runtime || !wasmTools)(
    'the envelope validates and its world is import host, export start',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'envelope-'));
      const asWat = join(dir, 'as.wat');
      writeFileSync(asWat, compile(loadSource(['src/as.hma'])));
      const build = (entry: string, out: string) =>
        writeFileSync(join(dir, out), execFileSync(runtime!, ['run', '--invoke', 'run', asWat], {
          input: compile(loadSource([entry])),
          maxBuffer: 1 << 26,
        }));
      build('examples/film.hma', 'film.wasm');
      build('examples/wav.hma', 'wav.wasm');
      build('examples/rgb2y4m.hma', 'rgb2y4m.wasm');
      const out = execFileSync('node', [
        'scripts/make-envelope.mjs', join(dir, 'film.wasm'), join(dir, 'envelope.wasm'),
        `examples/wav.hma=${join(dir, 'wav.wasm')}`,
        `examples/rgb2y4m.hma=${join(dir, 'rgb2y4m.wasm')}`,
      ], { maxBuffer: 1 << 24 }).toString();
      expect(out).toContain('validates as a component');
      const wit = execFileSync(wasmTools!, ['component', 'wit', join(dir, 'envelope.wasm')], {
        maxBuffer: 1 << 24,
      }).toString();
      expect(wit).toContain('import host: interface');
      expect(wit).toContain('export start: func()');
    },
    120000,
  );
});
