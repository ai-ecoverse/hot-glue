import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve('src/cli.ts');
const VERSION = JSON.parse(readFileSync('package.json', 'utf8')).version as string;

// Run the CLI the way a stranger would: from somewhere else entirely, with
// no ./src under foot to accidentally answer a (use …).
function hotglue(args: string[], opts: { input?: string; cwd?: string } = {}) {
  return execFileSync('npx', ['tsx', CLI, ...args], {
    input: opts.input ?? '',
    cwd: opts.cwd ?? tmpdir(),
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  });
}

describe('the command line, as `npx @ai-ecoverse/hot-glue` finds it', () => {
  it('prints usage for --help rather than opening a file called --help', () => {
    const out = hotglue(['--help']);
    expect(out).toContain('hotglue — expand WebAssembly macros');
    expect(out).toContain('npx @ai-ecoverse/hot-glue');
  });

  it('prints the version, and it is the published one', () => {
    expect(hotglue(['--version']).trim()).toBe(VERSION);
  });

  it('resolves (use …) from the shipped sources, not the current directory', () => {
    // tmpdir() has no src/prelude.hma. Only the lookup path's last resort —
    // the .hma files sitting beside the program — can answer this.
    const wat = hotglue([], { input: '(use prelude.hma)\n(module)\n' });
    expect(wat).toContain('(module');
  });

  it('still expands a file given by path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hotglue-cli-'));
    writeFileSync(join(dir, 'p.hma'), '(module (func (export "_start")))\n');
    expect(hotglue([join(dir, 'p.hma')])).toContain('(func (export "_start"))');
  });
});
