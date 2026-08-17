import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

const dir = mkdtempSync(join(tmpdir(), 'hotglue-wasm-'));
const asWat = join(dir, 'as.wat');
const expandWasm = join(dir, 'expand.wasm');
const asWasm = join(dir, 'as.wasm');
const hotglueWasm = join(dir, 'hotglue.wasm');

// the decreed flow: dependencies on the lookup path, hotglue.wasm
// against a .hma, a .wasm back
function driver(entry: string, input?: Buffer): Buffer {
  const args = [
    '--dir', 'src', '--dir', 'examples',
    '--preload', `expand=${expandWasm}`, '--preload', `as=${asWasm}`,
    hotglueWasm,
  ];
  if (entry) args.push(entry);
  return execFileSync(runtime!, args, { input: input ?? Buffer.alloc(0), maxBuffer: 1 << 26 });
}

// the bootstrap path, for holding the driver to byte-identity
function bootstrap(entry: string): Buffer {
  const wat = compile(loadSource([entry]));
  return execFileSync(runtime!, ['run', '--invoke', 'run', asWat], { input: wat, maxBuffer: 1 << 26 });
}

beforeAll(() => {
  if (!runtime) return;
  writeFileSync(asWat, compile(loadSource(['src/as.hma'])));
  const assemble = (entry: string, out: string) =>
    writeFileSync(
      out,
      execFileSync(runtime!, ['run', '--invoke', 'run', asWat], {
        input: compile(loadSource([entry])),
        maxBuffer: 1 << 26,
      }),
    );
  assemble('src/as.hma', asWasm);
  assemble('src/expand.hma', expandWasm);
  assemble('src/hotglue.hma', hotglueWasm);
});

describe.skipIf(!runtime)('hotglue.wasm — the compiler is a wasm binary', () => {
  it('a .hma in, a .wasm back, and it runs — no TypeScript in the flow', () => {
    const bin = driver('fizzbuzz.hma');
    expect(bin.subarray(0, 4)).toEqual(Buffer.from([0, 0x61, 0x73, 0x6d]));
    const out = join(dir, 'fizzbuzz.wasm');
    writeFileSync(out, bin);
    expect(execFileSync(runtime!, [out]).toString()).toContain('FizzBuzz');
  });

  it('resolves (use …) from the preopened lookup path, byte-identically to the bootstrap', () => {
    expect(driver('collatz.hma').equals(bootstrap('examples/collatz.hma'))).toBe(true);
    expect(driver('gpt.hma').equals(bootstrap('examples/gpt.hma'))).toBe(true);
    expect(driver('film.hma').equals(bootstrap('examples/film.hma'))).toBe(true);
  });

  it('reads stdin when given no entry', () => {
    const bin = driver('', Buffer.from('(module (func (export "seven") (result i32) (i32.const 7)))\n'));
    const out = join(dir, 'seven.wasm');
    writeFileSync(out, bin);
    expect(
      execFileSync(runtime!, ['run', '--invoke', 'seven', out], { stdio: ['pipe', 'pipe', 'pipe'] }).toString(),
    ).toContain('7');
  });

  it('rebuilds its own organs, and itself, byte for byte', () => {
    expect(driver('expand.hma').equals(readFileSync(expandWasm))).toBe(true);
    expect(driver('as.hma').equals(readFileSync(asWasm))).toBe(true);
    expect(driver('hotglue.hma').equals(readFileSync(hotglueWasm))).toBe(true);
  });

  it('dies helpfully when a use names a file off the path', () => {
    expect(() => driver('', Buffer.from('(use nowhere.hma)\n(module)\n'))).toThrow(/nowhere\.hma|lookup path/);
  });
});
