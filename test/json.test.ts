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

  it('a host glue-mem.hma relocates every base', () => {
    // (use …) resolves against the program's directory before src/,
    // so a host ships its own memory map and the libraries follow.
    writeFileSync(
      join(dir, 'glue-mem.hma'),
      `(defmacro jr-base () \`(i32.const 40960))\n(defmacro jw-base () \`(i32.const 41216))\n` +
        `(defmacro t-base () \`(i32.const 41472))\n(defmacro cov-base () \`(i32.const 49152))\n`,
    );
    const relo = join(dir, 'relo.hma');
    writeFileSync(
      relo,
      `(use clj.hma)\n(use glue-mem.hma)\n(use cov.hma)\n(use cov-clj.hma)\n(module\n` +
        `  (use glue-test.hma)\n  (use json-read.hma)\n  (use json-write.hma)\n` +
        `  (deftest $t-relo "the libraries follow the map"\n` +
        `    (call $jr-init (i32.const 43008) (i32.const 64) (i32.const 42496) (i32.const 32))\n` +
        `    (call $jr-fill "{\\"glue\\":450}")\n` +
        `    (call $jw-init (i32.const 45056) (i32.const 256) (i32.const 42624) (i32.const 32))\n` +
        `    (is= (call $jr-next) 1)\n    (call $jw-map-open)\n` +
        `    (is= (call $jr-next) 5)\n    (call $jw-key (jr-tok-ptr) (jr-tok-len))\n` +
        `    (is= (call $jr-next) 7)\n    (is= (jr-int) 450)\n    (call $jw-int (jr-int))\n` +
        `    (is= (call $jr-next) 2)\n    (call $jw-map-close)\n` +
        `    (is= (call $jr-eof) 11)\n` +
        `    (is-str (jw-buf) (jw-len) "{\\"glue\\":450}")\n    (is (zero? (jw-err))))\n` +
        `  (func (export "_start")\n    (run-tests)\n` +
        `    (if (call $t-sum?) (then (call $proc_exit (i32.const 1))))))\n`,
    );
    const wat = compile(loadSource([relo]));
    expect(wat).toContain('40960');
    expect(wat).not.toContain('8192');
    writeFileSync(join(dir, 'relo.wat'), wat);
    const out = execFileSync(runtime!, [join(dir, 'relo.wat')], {
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();
    expect(out).toContain('ok   the libraries follow the map');
    expect(out).toContain('0 failures');
  });

  it('node:wasi is a sufficient runner', () => {
    const asWat = join(dir, 'as2.wat');
    writeFileSync(asWat, compile(loadSource(['src/as.hma'])));
    const wasm = join(dir, 'suite-node.wasm');
    writeFileSync(
      wasm,
      execFileSync(runtime!, ['run', '--invoke', 'run', asWat], {
        input: readFileSync(watFile),
        maxBuffer: 1 << 26,
      }),
    );
    const out = execFileSync(
      'node',
      [
        '--no-warnings',
        '--input-type=module',
        '-e',
        `import { readFileSync } from 'node:fs';
import { WASI } from 'node:wasi';
const wasi = new WASI({ version: 'preview1' });
const mod = await WebAssembly.compile(readFileSync(${JSON.stringify(wasm)}));
const inst = await WebAssembly.instantiate(mod, wasi.getImportObject());
wasi.start(inst);`,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    ).toString();
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
