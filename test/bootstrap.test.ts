import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile } from '../src/bootstrap.js';

const wrap = (body: string) => compile(`(module ${body})`);

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

describe('hot glue stage 0', () => {
  it('expands a template macro', () => {
    const wat = wrap(`
      (defmacro $when (test body) \`(if ,test (then ,body)))
      (func ($when (i32.const 1) (nop)))`);
    expect(wat).toContain('(if (i32.const 1) (then (nop)))');
    expect(wat).not.toContain('defmacro');
  });

  it('keeps macro labels and user labels apart', () => {
    const wat = wrap(`
      (defmacro $forever (body) \`(block $break (loop $continue ,body (br $continue))))
      (func
        ($forever ($forever (nop)))
        (block $break (br $break)))`);
    expect(wat).toContain('$break.1');
    expect(wat).toContain('$continue.1');
    expect(wat).toContain('$break.2'); // the user's own, untouched by either macro
  });

  it('keeps macro locals and user locals apart, and hoists them', () => {
    const wat = wrap(`
      (defmacro $times (n body)
        \`(splice
           (local $t i32)
           (local.set $t (i32.const 0))
           (block $break
             (loop $continue
               (br_if $break (i32.ge_u (local.get $t) ,n))
               ,body
               (local.set $t (i32.add (local.get $t) (i32.const 1)))
               (br $continue)))))
      (func
        (local $t i32)
        ($times (i32.const 3) (local.set $t (local.get $t))))`);
    expect(wat).toContain('(local $t i32)');
    expect(wat).toContain('(local $t.1 i32)');
    expect(wat).toContain('(local.set $t (local.get $t))'); // the user's body kept its own $t
    const body = wat.slice(wat.indexOf('local.set'));
    expect(body).not.toContain('(local $'); // declarations all hoisted above the code
  });

  it('runs meta-code: $let via map and lambda', () => {
    const wat = wrap(`
      (defmacro $let (bindings body)
        \`(splice
           ,@(map (lambda (b) \`(local ,(first b) i32)) bindings)
           ,@(map (lambda (b) \`(local.set ,(first b) ,(second b))) bindings)
           ,body))
      (func (export "hyp2") (result i32)
        ($let (($x (i32.const 3)) ($y (i32.const 4)))
          (i32.add (i32.mul (local.get $x) (local.get $x))
                   (i32.mul (local.get $y) (local.get $y)))))`);
    expect(wat).toContain('(local $x i32)');
    expect(wat).toContain('(local.set $x (i32.const 3))');
  });

  it('runs meta-code: $unroll builds n copies', () => {
    const wat = wrap(`
      (defmacro $unroll (n var body)
        \`(splice ,@(map (lambda (i) (subst body var \`(i32.const ,i))) (nat n))))
      (func ($unroll 3 $i (call $f $i)))`);
    expect(wat).toContain('(call $f (i32.const 0))');
    expect(wat).toContain('(call $f (i32.const 2))');
  });

  it('&rest gathers trailing forms', () => {
    const wat = wrap(`
      (defmacro $seq (first &rest more) \`(block ,first ,@more))
      (func ($seq (nop) (nop) (unreachable)))`);
    expect(wat).toContain('(block (nop) (nop) (unreachable))');
  });

  it('unhygienic opts out, loudly', () => {
    const wat = wrap(`
      (defmacro $capturing (body) \`(block (unhygienic $break) ,body))
      (func (block $break ($capturing (br $break))))`);
    expect(wat).toContain('(block $break.1 (br $break.1))'); // macro block captures the user's br
  });

  it('pools inline strings into data segments', () => {
    const wat = wrap(`(func (call $print "Fizz") (call $print "Fizz") (call $print "\\n"))`);
    expect(wat).toContain('(call $print (i32.const 32) (i32.const 4))');
    expect(wat).toContain('(data (i32.const 32) "Fizz")');
    expect(wat).toContain('(data (i32.const 36) "\\n")');
    expect(wat.match(/data/g)).toHaveLength(2); // "Fizz" pooled once
  });

  it.skipIf(!runtime)('fizzbuzz: expands, validates, and runs', () => {
    const wat = compile(readFileSync('examples/fizzbuzz.hma', 'utf8'));
    const file = join(mkdtempSync(join(tmpdir(), 'hotglue-')), 'fizzbuzz.wat');
    writeFileSync(file, wat);
    const got = execFileSync(runtime!, [file], { encoding: 'utf8' });
    const want =
      [...Array(100).keys()]
        .map((i) => i + 1)
        .map((i) => (i % 15 === 0 ? 'FizzBuzz' : i % 3 === 0 ? 'Fizz' : i % 5 === 0 ? 'Buzz' : String(i)))
        .join('\n') + '\n';
    expect(got).toBe(want);
  });
});
