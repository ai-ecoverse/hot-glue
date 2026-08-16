import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile, loadSource } from '../../src/hotglue/bootstrap.js';

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

const dir = mkdtempSync(join(tmpdir(), 'hotglue-as-'));
const asWat = join(dir, 'as.wat');

/** Run a module (wat text or wasm binary path) as the assembler, stdin → stdout. */
const assemble = (module: string, input: string | Buffer): Buffer =>
  execFileSync(runtime!, [module], { input, maxBuffer: 1 << 26 });

const run = (wasm: Buffer, args: string[] = []): Buffer => {
  const f = join(dir, `run-${wasm.length}.wasm`);
  writeFileSync(f, wasm);
  return execFileSync(runtime!, [f, ...args], { maxBuffer: 1 << 26, stdio: ['pipe', 'pipe', 'pipe'] });
};

beforeAll(() => {
  writeFileSync(asWat, compile(loadSource(['src/hotglue/as.hma'])));
});

describe.skipIf(!runtime)('as.hma — the assembler', () => {
  it('assembles a constant function', () => {
    const wasm = assemble(asWat, '(module (func (export "answer") (result i32) (i32.const 42)))');
    expect([...wasm.subarray(0, 8)]).toEqual([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
    const f = join(dir, 'answer.wasm');
    writeFileSync(f, wasm);
    const got = execFileSync(runtime!, ['run', '--invoke', 'answer', f], { stdio: ['pipe', 'pipe', 'pipe'] });
    expect(got.toString().trim()).toBe('42');
  });

  it('assembles fizzbuzz, which then runs', () => {
    const wat = compile(readFileSync('examples/fizzbuzz.hma', 'utf8'));
    const got = run(assemble(asWat, wat)).toString();
    const want =
      [...Array(100).keys()]
        .map((i) => i + 1)
        .map((i) => (i % 15 === 0 ? 'FizzBuzz' : i % 3 === 0 ? 'Fizz' : i % 5 === 0 ? 'Buzz' : String(i)))
        .join('\n') + '\n';
    expect(got).toBe(want);
  });

  it('assembles the GC AST — rec groups, casts, and all', () => {
    const wat = compile(readFileSync('examples/gc-ast.hma', 'utf8'));
    const f = join(dir, 'gc.wasm');
    writeFileSync(f, assemble(asWat, wat));
    const got = execFileSync(runtime!, ['run', '-W', 'gc,function-references', '--invoke', 'demo', f], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(got.toString().trim()).toBe('15');
  });

  it('self-hosts: assembles itself to a fixpoint', () => {
    const text = readFileSync(asWat, 'utf8');
    const child = assemble(asWat, text); // wasmtime-parsed assembler assembles its own source
    const childFile = join(dir, 'as2.wasm');
    writeFileSync(childFile, child);
    const grandchild = assemble(childFile, text); // the binary it made does the same
    expect(child.equals(grandchild)).toBe(true); // and the two agree, byte for byte
    const answer = assemble(childFile, '(module (func (export "answer") (result i32) (i32.const 42)))');
    expect(answer.subarray(0, 4).toString('latin1')).toBe('\0asm'); // the child is a working assembler
  });
});
