import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile } from '../../src/hotglue/bootstrap.js';

function wasmtime(): string | null {
  for (const bin of ['wasmtime', join(process.env.HOME ?? '', '.local/bin/wasmtime')]) {
    try {
      execFileSync(bin, ['--version'], { stdio: 'pipe' });
      return bin;
    } catch {
      /* keep looking */
    }
  }
  return null;
}
const runtime = wasmtime();

const dir = mkdtempSync(join(tmpdir(), 'hotglue-clj-'));
const src = (...files: string[]) => files.map((f) => readFileSync(f, 'utf8')).join('\n');
const watFile = join(dir, 'collatz.wat');

const invoke = (name: string, ...args: string[]) =>
  execFileSync(runtime!, ['run', '--invoke', name, watFile, ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
    .toString()
    .trim();

beforeAll(() => {
  writeFileSync(watFile, compile(src('src/hotglue/clj.hma', 'examples/collatz.hma')));
});

describe.skipIf(!runtime)('clj.hma — the Clojure accent', () => {
  it('loop/recur: collatz of 27 takes 111 steps', () => {
    expect(invoke('steps', '27')).toBe('111');
  });

  it('let, dotimes, and folding arithmetic: sum of squares below ten', () => {
    expect(invoke('sum-squares')).toBe('285');
  });

  it('flat cond with :else', () => {
    expect(invoke('classify', '0')).toBe('0');
    expect(invoke('classify', '9')).toBe('1');
  });

  it('threading first: (-> n (+ 1) (* 2) (- 3) inc)', () => {
    expect(invoke('thread', '4')).toBe('8');
  });

  it('the assembled binary agrees', () => {
    const asWat = join(dir, 'as.wat');
    writeFileSync(asWat, compile(src('src/hotglue/prelude.hma', 'src/hotglue/as.hma')));
    const bin = execFileSync(runtime!, [asWat], { input: readFileSync(watFile), maxBuffer: 1 << 26 });
    const wasm = join(dir, 'collatz.wasm');
    writeFileSync(wasm, bin);
    const got = execFileSync(runtime!, ['run', '--invoke', 'steps', wasm, '27'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(got.toString().trim()).toBe('111');
  });
});
