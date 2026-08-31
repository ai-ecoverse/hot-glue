import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const CLI = resolve('src/hotglue.ts');
const VERSION = JSON.parse(readFileSync('package.json', 'utf8')).version as string;

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

// The CLI drives the organs; the organs are minted by the bootstrap. What
// the release ships in dist/, the tests hand it in a temporary directory.
const organs = mkdtempSync(join(tmpdir(), 'hotglue-cli-organs-'));

beforeAll(() => {
  if (!runtime) return;
  execFileSync('bash', ['scripts/bootstrap.sh', organs], {
    stdio: 'ignore',
    env: { ...process.env, PATH: `${dirname(runtime)}:${process.env.PATH}` },
  });
});

// Run the CLI the way a stranger would: from somewhere else entirely, with
// no ./src under foot to accidentally answer a (use …).
function hotglue(args: string[], opts: { input?: string; cwd?: string } = {}) {
  return execFileSync('npx', ['tsx', CLI, ...args], {
    input: opts.input ?? '',
    cwd: opts.cwd ?? tmpdir(),
    maxBuffer: 1 << 26,
    env: { ...process.env, HOTGLUE_DIST: organs },
  });
}
const text = (args: string[], opts?: { input?: string; cwd?: string }) =>
  hotglue(args, opts).toString();

describe('the command line, as `npx @ai-ecoverse/hot-glue` finds it', () => {
  it('prints usage for --help rather than opening a file called --help', () => {
    const out = text(['--help']);
    expect(out).toContain('hotglue — expand WebAssembly macros');
    expect(out).toContain('npx @ai-ecoverse/hot-glue');
  });

  it('prints the version, and it is the published one', () => {
    expect(text(['--version']).trim()).toBe(VERSION);
  });

  it.skipIf(!runtime)('resolves (use …) from the shipped sources, not the current directory', () => {
    // tmpdir() has no src/prelude.hma. Only the lookup path's last resort —
    // the .hma files sitting beside the program — can answer this.
    expect(text([], { input: '(use prelude.hma)\n(module)\n' })).toContain('(module');
  });

  it.skipIf(!runtime)('still expands a file given by path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hotglue-cli-'));
    writeFileSync(join(dir, 'p.hma'), '(module (func (export "_start")))\n');
    expect(text([join(dir, 'p.hma')])).toContain('(func (export "_start"))');
  });

  // The argument form used to be the one place the lookup path did not
  // reach: a (use as.hma) off stdin found the shipped source and a bare
  // `hotglue as.hma` did not. Same path, same answer, either way in.
  it.skipIf(!runtime)('takes a bare name off the lookup path, the way a (use …) does', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'hotglue-bare-'));
    expect(text(['as.hma'], { cwd: elsewhere })).toContain('(module');
  });

  it.skipIf(!runtime)('assembles with -w, with no wasmtime and no binaryen in it', () => {
    const bin = hotglue(['-w'], { input: '(module (func (export "_start")))\n' });
    expect(bin.subarray(0, 4)).toEqual(Buffer.from([0, 0x61, 0x73, 0x6d]));
  });

  // The shipped assembler is what the shipped sources assemble to. It is
  // the claim a consumer of the package cannot otherwise check.
  it.skipIf(!runtime)('rebuilds the assembler it ships, byte for byte', () => {
    const bin = hotglue(['-w'], { input: '(use as.hma)\n' });
    expect(bin.equals(readFileSync(join(organs, 'as.wasm')))).toBe(true);
  });
});
