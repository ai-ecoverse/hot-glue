import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { compile, expand, wasmPath } from '../src/drive.js';
import { compile as stage0, loadSource } from '../src/bootstrap.js';

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

// The organs the driver drives, built the way the release builds them.
// Nothing below this line needs wasmtime — hosting them is Node's job —
// but minting them in the first place is what stage 3 is.
const organs = mkdtempSync(join(tmpdir(), 'hotglue-organs-'));

beforeAll(() => {
  if (!runtime) return;
  execFileSync('bash', ['scripts/bootstrap.sh', organs], {
    stdio: 'ignore',
    env: { ...process.env, PATH: `${dirname(runtime)}:${process.env.PATH}` },
  });
  process.env.HOTGLUE_DIST = organs;
});

const bytes = (s: string | Uint8Array) => Buffer.from(s as Uint8Array);

describe.skipIf(!runtime)('the driver — Node hosts the toolchain, and nothing else has to', () => {
  it('prints what stage 0 prints, byte for byte, on the corpus that matters', () => {
    for (const entry of [
      'examples/fizzbuzz.hma',
      'examples/collatz.hma',
      'examples/gc-ast.hma',
      'src/as.hma',
      'src/expand.hma',
      'src/hotglue.hma',
    ]) {
      const wat = expand(readFileSync(entry), { dirs: [dirname(entry)] });
      expect(bytes(wat).equals(bytes(stage0(loadSource([entry])))), entry).toBe(true);
    }
  });

  it('assembles its own organs back to the bytes the bootstrap made', () => {
    for (const organ of ['as', 'expand', 'hotglue']) {
      const { bin } = compile(readFileSync(`src/${organ}.hma`), { dirs: ['src'] });
      expect(bytes(bin).equals(readFileSync(join(organs, `${organ}.wasm`))), organ).toBe(true);
    }
  });

  it('resolves a (use …) against the sources shipped beside it', () => {
    // no dirs given: only the lookup path's last resort can answer this
    const { bin } = compile('(use prelude.hma)\n(module (func (export "_start")))\n');
    expect(bin.subarray(0, 4)).toEqual(new Uint8Array([0, 0x61, 0x73, 0x6d]));
  });

  it('names the file a (use …) could not find', () => {
    expect(() => compile('(use nowhere.hma)\n(module)\n')).toThrow(/nowhere\.hma/);
  });

  // The subset the assembler accepts is not the subset WAT has — mutable
  // globals are outside it today. Asking for WAT should still get WAT.
  it('keeps the WAT when the assembler refuses it, and says so', () => {
    const src = '(module (global $g (mut i32) (i32.const 0)) (func (export "f") (result i32) (global.get $g)))\n';
    const warnings: string[] = [];
    const wat = expand(src, { onWarn: (m) => warnings.push(m) });
    expect(bytes(wat).toString()).toContain('global.get');
    expect(warnings.join()).toMatch(/assembler refused/);
    expect(() => compile(src)).toThrow();
  });

  it('points at the organs it drove', () => {
    expect(existsSync(wasmPath('as'))).toBe(true);
    expect(readFileSync(wasmPath('as')).subarray(0, 4)).toEqual(
      Buffer.from([0, 0x61, 0x73, 0x6d]),
    );
  });
});
