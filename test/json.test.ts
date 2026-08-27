import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile, loadSource } from '../src/bootstrap.js';

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

const dir = mkdtempSync(join(tmpdir(), 'hotglue-json-'));
const watFile = join(dir, 'suite.wat');

// The suite is its own verdict: it exits 0 only when every assertion
// held, and prints its coverage as measured by its own probes. The
// host merely reads the transcript.
const verdict = (out: string) => {
  expect(out).toContain('0 failures');
  expect(out).toContain('coverage 254/254 (100%)');
  expect(out).not.toContain('miss ');
};

beforeAll(() => {
  writeFileSync(watFile, compile(loadSource(['test/json-suite.hma'])));
});

describe.skipIf(!runtime)('json-read, json-write, glue-test — under the meter', () => {
  it('the suite passes with 100% coverage', () => {
    const out = execFileSync(runtime!, [watFile], { stdio: ['pipe', 'pipe', 'pipe'] }).toString();
    verdict(out);
    expect(out).toMatch(/ok {3}reads the three literals/);
    expect(out).toMatch(/ok {3}reader and writer agree on the kitchen sink/);
  });

  it('the assembled binary agrees', () => {
    const asWat = join(dir, 'as.wat');
    writeFileSync(asWat, compile(loadSource(['src/as.hma'])));
    const bin = execFileSync(runtime!, ['run', '--invoke', 'run', asWat], {
      input: readFileSync(watFile),
      maxBuffer: 1 << 26,
    });
    const wasm = join(dir, 'suite.wasm');
    writeFileSync(wasm, bin);
    const out = execFileSync(runtime!, [wasm], { stdio: ['pipe', 'pipe', 'pipe'] }).toString();
    verdict(out);
  });

  it('a failing suite exits nonzero', () => {
    const bad = join(dir, 'bad.hma');
    writeFileSync(
      bad,
      `(use clj.hma)\n(use cov.hma)\n(use cov-clj.hma)\n(module\n  (use glue-test.hma)\n` +
        `  (deftest $t-no "one is zero" (is= 1 0))\n` +
        `  (func (export "_start")\n    (run-tests)\n` +
        `    (if (call $t-sum?) (then (call $proc_exit (i32.const 1))))))\n`,
    );
    const badWat = join(dir, 'bad.wat');
    writeFileSync(badWat, compile(loadSource([bad])));
    let code = 0;
    let out = '';
    try {
      execFileSync(runtime!, [badWat], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e: any) {
      code = e.status;
      out = e.stdout.toString();
    }
    expect(code).toBe(1);
    expect(out).toContain('FAIL one is zero');
    expect(out).toContain('1 failures');
  });
});

// The wasm compiler is built by `npm run bootstrap`; when it exists,
// it must tell the same story with no TypeScript in the room.
const dist = ['dist/hotglue/hotglue.wasm', 'dist/hotglue/expand.wasm', 'dist/hotglue/as.wasm'];

describe.skipIf(!runtime || !dist.every((p) => existsSync(p)))('the wasm compiler, on the suite', () => {
  it('compiles the suite to the same verdict', () => {
    const wasm = join(dir, 'suite-native.wasm');
    writeFileSync(
      wasm,
      execFileSync(
        runtime!,
        [
          '--dir', 'src', '--dir', 'test', '--dir', '.',
          '--preload', 'expand=dist/hotglue/expand.wasm',
          '--preload', 'as=dist/hotglue/as.wasm',
          'dist/hotglue/hotglue.wasm',
          'test/json-suite.hma',
        ],
        { maxBuffer: 1 << 26 },
      ),
    );
    const out = execFileSync(runtime!, [wasm], { stdio: ['pipe', 'pipe', 'pipe'] }).toString();
    verdict(out);
  });
});
