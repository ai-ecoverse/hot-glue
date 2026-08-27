import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Hot Glue, stage 0 — the bootstrap expander (docs/wasm-macros.md § 9).
 *
 * One file: reader, expander, lowerer. A node is a number, a string,
 * a symbol, or a list. Symbols carry hygiene marks in a bitset. Each
 * macro invocation XORs one fresh mark across its input and its
 * output: call-site symbols wear it twice and shed it, template
 * symbols wear it once and keep it. The lowerer resolves locals and
 * labels by name-plus-marks and prints plain WAT. Names are debug
 * output. Marks are law.
 *
 * Stage 0 simplifications, owned in daylight: macro names resolve by
 * name alone, quasiquote does not nest, locations are not tracked.
 * Jurisdiction arrives with stage 1.
 */

export class Sym {
  readonly name: string;
  readonly marks: bigint;
  constructor(name: string, marks = 0n) {
    this.name = name;
    this.marks = marks;
  }
}
export type Node = number | string | Sym | Node[];

// ------------------------------------------------------------ imports
//
// A (use name.hma) splices the named file from the lookup path in place
// of the form, once per name — the second use of a name anywhere in the
// program splices nothing. It is not restricted to the top level: a form
// may pull a file into itself, which is how a (module …) is composed from
// several files of functions. Resolution is textual and
// byte-faithful: everything that is not a top-level use form passes
// through verbatim, comments and strings respected, so all engines
// that resolve imports produce the identical stream. The wasm driver
// mirrors this state machine; keep them in lockstep.

export function resolveUses(
  src: string,
  readNamed: (name: string) => string,
  seen: Set<string> = new Set(),
): string {
  let out = '';
  let i = 0;
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ';' && src[i + 1] === ';') {
      let j = src.indexOf('\n', i);
      if (j < 0) j = src.length;
      out += src.slice(i, j);
      i = j;
    } else if (c === '(' && src[i + 1] === ';') {
      const e = src.indexOf(';)', i);
      const j = e < 0 ? src.length : e + 2;
      out += src.slice(i, j);
      i = j;
    } else if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
      j++;
      out += src.slice(i, j);
      i = j;
    } else if (c === '(' && src.startsWith('use', i + 1) && /\s/.test(src[i + 4] ?? '')) {
      const close = src.indexOf(')', i);
      if (close < 0) throw new Error('use: unclosed form');
      const name = src.slice(i + 4, close).trim();
      i = close + 1;
      if (!seen.has(name)) {
        seen.add(name);
        out += resolveUses(readNamed(name), readNamed, seen);
      }
    } else {
      if (c === '(') depth++;
      if (c === ')') depth--;
      out += c;
      i++;
    }
  }
  return out;
}

// Load entry files, resolving (use …) against the lookup path: the
// entries' own directories, any extra dirs, then the toolchain's home.
export function loadSource(paths: string[], extraDirs: string[] = []): string {
  const seen = new Set<string>();
  const home = dirname(new URL(import.meta.url).pathname);
  const dirs = [...paths.map((p) => dirname(p)), ...extraDirs, 'src', home];
  const readNamed = (name: string): string => {
    for (const d of dirs) {
      const p = join(d, name);
      if (existsSync(p)) return readFileSync(p, 'utf8');
    }
    throw new Error(`use: ${name} not found (looked in ${dirs.join(', ')})`);
  };
  return paths.map((p) => resolveUses(readFileSync(p, 'utf8'), readNamed, seen)).join('\n');
}

const sym = (name: string) => new Sym(name);
const key = (s: Sym) => (s.marks ? `${s.name}#${s.marks.toString(36)}` : s.name);
const head = (n: Node): string => (Array.isArray(n) && n[0] instanceof Sym ? n[0].name : '');

// ---------------------------------------------------------------- reader

export function read(src: string): Node[] {
  let i = 0;
  const die = (m: string): never => {
    throw new Error(`read: ${m}`);
  };
  const skip = () => {
    for (;;) {
      while (i < src.length && /\s/.test(src[i])) i++;
      if (src.startsWith(';;', i)) {
        while (i < src.length && src[i] !== '\n') i++;
      } else if (src.startsWith('(;', i)) {
        const e = src.indexOf(';)', i);
        i = e < 0 ? die('unclosed (;') : e + 2;
      } else return;
    }
  };
  const form = (): Node => {
    skip();
    if (i >= src.length) die('unexpected end');
    const c = src[i];
    if (c === '(') {
      i++;
      const xs: Node[] = [];
      while ((skip(), src[i] !== ')')) xs.push(form());
      i++;
      return xs;
    }
    if (c === ')') die('stray )');
    if (c === '[') {
      i++;
      const xs: Node[] = [];
      while ((skip(), src[i] !== ']')) xs.push(form());
      i++;
      return xs;
    }
    if (c === ']') die('stray ]');
    if (c === '`') return i++, [sym('quasiquote'), form()];
    if (c === ',') return i++, src[i] === '@' ? (i++, [sym('unquote-splicing'), form()]) : [sym('unquote'), form()];
    if (c === "'") return i++, [sym('quote'), form()];
    if (c === '"') {
      i++;
      let s = '';
      while (src[i] !== '"') {
        if (i >= src.length) die('unclosed string');
        let ch = src[i++];
        if (ch === '\\') {
          const e = src[i++];
          ch = e === 'n' ? '\n' : e === 't' ? '\t' : e === '"' || e === '\\' ? e : die(`escape \\${e}`);
        }
        s += ch;
      }
      i++;
      return s;
    }
    let j = i;
    while (j < src.length && !/[\s();"'`,[\]]/.test(src[j])) j++;
    if (j === i) die(`unexpected ${src[i]}`);
    const t = src.slice(i, j);
    i = j;
    // Only plain integers become numbers. Float-looking tokens stay
    // symbols and travel as text: hygiene never looks inside them,
    // and the assembler alone mints their IEEE bits. This keeps all
    // three expanders byte-identical without teaching two of them
    // to print doubles the way JavaScript does.
    return /^-?\d+$/.test(t) ? Number(t) : new Sym(t);
  };
  const forms: Node[] = [];
  while ((skip(), i < src.length)) forms.push(form());
  return forms;
}

// --------------------------------------------------- the meta-language

type Closure = { params: Sym[]; body: Node[]; env: Env };

class Env {
  private bound = new Map<string, unknown>();
  private parent?: Env;
  constructor(parent?: Env) {
    this.parent = parent;
  }
  get(s: Sym): unknown {
    for (let e: Env | undefined = this; e; e = e.parent) if (e.bound.has(key(s))) return e.bound.get(key(s));
    throw new Error(`unbound: ${s.name}`);
  }
  set(s: Sym, v: unknown) {
    this.bound.set(key(s), v);
  }
}

const call = (f: unknown, args: unknown[]): unknown => {
  if (typeof f === 'function') return f(...args);
  const { params, body, env } = f as Closure;
  const e = new Env(env);
  params.forEach((p, i) => e.set(p, args[i]));
  return body.reduce<unknown>((_, x) => meval(x, e), undefined);
};

function meval(n: Node, env: Env): unknown {
  if (n instanceof Sym) return env.get(n);
  if (!Array.isArray(n)) return n;
  const [h, ...r] = n;
  if (h instanceof Sym)
    switch (h.name) {
      case 'quote':
        return r[0];
      case 'quasiquote':
        return qq(r[0], env);
      case 'if':
        return meval(r[0], env) ? meval(r[1], env) : r[2] !== undefined ? meval(r[2], env) : undefined;
      case 'lambda':
        return { params: r[0] as Sym[], body: r.slice(1), env };
      case 'let': {
        const e = new Env(env);
        for (const b of r[0] as Node[][]) e.set(b[0] as Sym, meval(b[1], e));
        return r.slice(1).reduce<unknown>((_, x) => meval(x, e), undefined);
      }
    }
  return call(
    meval(h, env),
    r.map((x) => meval(x, env)),
  );
}

function qq(n: Node, env: Env): Node {
  if (!Array.isArray(n)) return n;
  if (head(n) === 'unquote') return meval(n[1], env) as Node;
  const out: Node[] = [];
  for (const x of n) {
    if (head(x) === 'unquote-splicing') out.push(...(meval((x as Node[])[1], env) as Node[]));
    else out.push(qq(x, env));
  }
  return out;
}

function prelude(): Env {
  const g = new Env();
  const def = (n: string, f: unknown) => g.set(sym(n), f);
  let gen = 0;
  def('list', (...xs: Node[]) => xs);
  def('cons', (x: Node, xs: Node[]) => [x, ...xs]);
  def('first', (xs: Node[]) => xs[0]);
  def('second', (xs: Node[]) => xs[1]);
  def('rest', (xs: Node[]) => xs.slice(1));
  def('reverse', (xs: Node[]) => [...xs].reverse());
  def('length', (xs: Node[]) => xs.length);
  def('nat', (n: number) => [...Array(n).keys()]);
  def('map', (f: unknown, xs: Node[]) => xs.map((x) => call(f, [x]) as Node));
  def('sym', (n: string) => sym(n));
  def('sym?', (x: Node) => x instanceof Sym);
  def('sym-is?', (x: Node, n: string) => x instanceof Sym && x.name === n);
  def('list?', (x: Node) => Array.isArray(x));
  def('gensym', () => sym(`$g${gen++}`));
  def('=', (a: unknown, b: unknown) => a === b);
  def('+', (a: number, b: number) => a + b);
  def('-', (a: number, b: number) => a - b);
  def('*', (a: number, b: number) => a * b);
  def('<', (a: number, b: number) => a < b);
  def('subst', (t: Node, s: Sym, r: Node): Node => {
    const go = (n: Node): Node => (n instanceof Sym && key(n) === key(s) ? r : Array.isArray(n) ? n.map(go) : n);
    return go(t);
  });
  def('error', (m: unknown) => {
    throw new Error(`macro error: ${m}`);
  });
  return g;
}

// -------------------------------------------------------- the expander

type Macro = { params: Sym[]; body: Node[] };

export function expand(forms: Node[]): Node[] {
  const macros = new Map<string, Macro>();
  const genv = prelude();
  let mark = 0n;

  const flip = (n: Node, m: bigint): Node =>
    n instanceof Sym ? new Sym(n.name, n.marks ^ m) : Array.isArray(n) ? n.map((x) => flip(x, m)) : n;
  const strip = (n: Node): Node => (n instanceof Sym ? sym(n.name) : Array.isArray(n) ? n.map(strip) : n);

  const one = (n: Node): Node => {
    for (let fuel = 999; ; ) {
      const mac = Array.isArray(n) && n[0] instanceof Sym ? macros.get(n[0].name) : undefined;
      if (!mac) break;
      if (!fuel--) throw new Error(`divergent macro: ${print(n)}`);
      const m = 1n << mark++;
      const args = (flip(n, m) as Node[]).slice(1);
      const rest = mac.params.findIndex((p) => p.name === '&rest');
      if (rest < 0 ? args.length !== mac.params.length : args.length < rest)
        throw new Error(`${head(n)}: expected ${rest < 0 ? mac.params.length : `${rest}+`} forms, got ${args.length}`);
      const e = new Env(genv);
      mac.params.forEach((p, i) => {
        if (i !== rest) e.set(p, rest < 0 || i < rest ? args[i] : args.slice(rest));
      });
      n = flip(
        mac.body.reduce<Node>((_, x) => meval(x, e) as Node, []),
        m,
      );
    }
    if (!Array.isArray(n)) return n;
    if (head(n) === 'defmacro') {
      const [, name, params, ...body] = n as [Node, Sym, Sym[], ...Node[]];
      macros.set(name.name, { params, body });
      return [sym('splice')];
    }
    if (head(n) === 'unhygienic') return strip(one(n[1]));
    const out: Node[] = [];
    for (const c of n) {
      const x = one(c);
      if (head(x) === 'splice') out.push(...(x as Node[]).slice(1));
      else out.push(x);
    }
    return out;
  };

  return forms.flatMap((f) => {
    const x = one(f);
    return head(x) === 'splice' ? (x as Node[]).slice(1) : [x];
  });
}

// --------------------------------------------------------- the lowerer

const SIG = new Set(['export', 'import', 'type', 'param', 'result']);
const LABELED = new Set(['block', 'loop', 'if']);
const BRANCH = new Set(['br', 'br_if', 'br_table', 'br_on_cast']);
const VARREF = new Set(['local.get', 'local.set', 'local.tee']);

export function lower(mod: Node[]): Node[] {
  const pool = new Map<string, [number, number]>();
  let off = 32; // 0–31 is scratch, by convention of the prelude
  const intern = (s: string): [number, number] => {
    let p = pool.get(s);
    if (!p) pool.set(s, (p = [off, Buffer.byteLength(s)])), (off += p[1]);
    return p;
  };

  const lowerFunc = (f: Node[]): Node[] => {
    const printed = new Set<string>();
    const fresh = (name: string) => {
      let p = name;
      for (let i = 1; printed.has(p); i++) p = `${name}.${i}`;
      printed.add(p);
      return p;
    };
    const vars = new Map<string, string>();
    const seen = new Set<string>();
    const locals: Node[][] = [];

    // Pull (local ...) declarations out of the body. WAT wants them
    // at the head. Macros want to write them where they bind. Both get
    // their way. (docs/wasm-macros.md § 6.2)
    const sweep = (n: Node): Node | null => {
      if (!Array.isArray(n)) return n;
      if (head(n) === 'local' && n[1] instanceof Sym) {
        const k = key(n[1]);
        if (!seen.has(k)) seen.add(k), locals.push(n as Node[]);
        return null;
      }
      return n.map(sweep).filter((x): x is Node => x !== null);
    };

    const names: Node[] = [];
    const sig: Node[] = [];
    const code: Node[] = [];
    for (const c of f.slice(1)) {
      if (c instanceof Sym && !sig.length && !code.length) names.push(c);
      else if (Array.isArray(c) && SIG.has(head(c))) sig.push(c);
      else {
        const s = sweep(c);
        if (s !== null) code.push(s);
      }
    }

    const declare = (d: Node[]): Node[] => {
      if (!(d[1] instanceof Sym)) return d;
      const p = fresh(d[1].name);
      vars.set(key(d[1]), p);
      return [d[0], sym(p), ...d.slice(2)];
    };
    const sig2 = sig.map((c) => (head(c) === 'param' ? declare(c as Node[]) : c));
    const locals2 = locals.map(declare);

    const resolve = (map: Map<string, string>, s: Node): Node => (s instanceof Sym ? sym(map.get(key(s)) ?? s.name) : s);

    const walk = (n: Node, labels: Map<string, string>): Node => {
      if (!Array.isArray(n)) return n;
      const h = head(n);
      if (VARREF.has(h)) return [n[0], resolve(vars, n[1]), ...n.slice(2).map((x) => walk(x, labels))];
      if (BRANCH.has(h)) return [n[0], ...n.slice(1).map((x) => (x instanceof Sym ? resolve(labels, x) : walk(x, labels)))];
      let scope = labels;
      let rest = n.slice(1);
      const out: Node[] = [n[0]];
      if (LABELED.has(h) && rest[0] instanceof Sym) {
        scope = new Map(labels);
        const p = fresh((rest[0] as Sym).name);
        scope.set(key(rest[0] as Sym), p);
        out.push(sym(p));
        rest = rest.slice(1);
      }
      for (const c of rest) {
        if (typeof c === 'string') {
          const [at, len] = intern(c);
          out.push([sym('i32.const'), at], [sym('i32.const'), len]);
        } else out.push(walk(c, scope));
      }
      return out;
    };

    return [f[0], ...names, ...sig2, ...locals2, ...code.map((c) => walk(c, new Map()))];
  };

  const out = mod.map((c) => (Array.isArray(c) && head(c) === 'func' ? lowerFunc(c as Node[]) : c));
  for (const [s, [at]] of pool) out.push([sym('data'), [sym('i32.const'), at], s]);
  return out;
}

// --------------------------------------------------------- the printer

const esc = (s: string) =>
  [...Buffer.from(s, 'utf8')]
    .map((b) =>
      b === 34 ? '\\"' : b === 92 ? '\\\\' : b === 10 ? '\\n' : b === 9 ? '\\t' : b >= 32 && b < 127 ? String.fromCharCode(b) : '\\' + b.toString(16).padStart(2, '0'),
    )
    .join('');

// The flat, single-line rendering of a node does not depend on the indent
// depth it is printed at, so memoize it. Without this, print() re-renders
// every subtree once per level of nesting it sits under — quadratic in depth,
// which the large self-hosting sources (as.hma, expand.hma) feel sharply.
//
// The cache lives for one top-level print() and no longer: a node is
// immutable by convention, not by type, and this file hands out both print()
// and a mutable Node[]. A cache that outlived the call would answer for the
// tree as it was first seen rather than as it is. Within the call the tree
// cannot change, which is where the quadratic behaviour lives anyway.
type FlatCache = WeakMap<Node[], string>;

function printFlat(n: Node, cache: FlatCache): string {
  if (n instanceof Sym) return n.name;
  if (typeof n === 'string') return `"${esc(n)}"`;
  if (typeof n === 'number') return String(n);
  let s = cache.get(n);
  if (s === undefined) {
    s = `(${n.map((x) => printFlat(x, cache)).join(' ')})`;
    cache.set(n, s);
  }
  return s;
}

export function print(n: Node, d = 0): string {
  return printAt(n, d, new WeakMap());
}

function printAt(n: Node, d: number, cache: FlatCache): string {
  if (n instanceof Sym) return n.name;
  if (typeof n === 'string') return `"${esc(n)}"`;
  if (typeof n === 'number') return String(n);
  const flat = printFlat(n, cache);
  if (d * 2 + flat.length <= 100) return flat;
  let i = 1;
  let line = printAt(n[0], 0, cache);
  while (i < n.length && !Array.isArray(n[i])) line += ' ' + printAt(n[i++], 0, cache);
  const pad = '  '.repeat(d + 1);
  return `(${line}\n${n
    .slice(i)
    .map((x) => pad + printAt(x, d + 1, cache))
    .join('\n')})`;
}

// ------------------------------------------------------------ pipeline

export function compile(src: string): string {
  return (
    expand(read(src))
      .map((f) => print(Array.isArray(f) && head(f) === 'module' ? lower(f as Node[]) : f))
      .join('\n') + '\n'
  );
}
