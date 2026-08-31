#!/usr/bin/env bash
#
# The gate. CI runs this on every branch; the release workflow runs this
# same script before it publishes. That is the whole point of it being a
# script rather than two lists of steps in two YAML files: a green pull
# request means a green release, because it is the identical check.
#
# Runnable by hand, too: `bash scripts/verify.sh`.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

echo "==> build"
npm run build

echo "==> test"
npm test

# The suite proves the language. This proves the *package* — that what npm
# hands a stranger has a main, a bin, and a prelude that resolves from
# somewhere that is not a checkout. Both of those have been broken before,
# and neither is something the suite can see: it runs against src/.
echo "==> pack, install, and run as a stranger would"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

tarball="$(npm pack --silent | tail -1)"
mv "$tarball" "$work/"
cp examples/fizzbuzz.hma "$work/"

cd "$work"
npm init -y >/dev/null 2>&1
npm install --silent "./$tarball"

# main resolves and exports what the library promises
node -e '
  import("@ai-ecoverse/hot-glue").then((m) => {
    for (const name of ["compile", "expand", "wasmPath", "lookupPath"]) {
      if (typeof m[name] !== "function") throw new Error(`main is missing ${name}`);
    }
    console.log("    main exports ok");
  }).catch((e) => { console.error(e.message); process.exit(1); });
'

# the bin is executable without tsx, and knows its own name and version
./node_modules/.bin/hotglue --help | grep -q "expand WebAssembly macros"
echo "    --help ok"
test "$(./node_modules/.bin/hotglue --version)" = "$(node -p 'require("./node_modules/@ai-ecoverse/hot-glue/package.json").version')"
echo "    --version ok"

# a (use …) off stdin, in a directory with no ./src to answer it by accident
printf '(use prelude.hma)\n(module)\n' | ./node_modules/.bin/hotglue | grep -q '(module'
echo "    stdin (use …) resolves against the shipped sources"

# The compiler in the tarball is wasm. There is no TypeScript expander in
# here to fall back on and no wasmtime on the far side of this install, so
# a binary coming out of the next few lines is the whole claim of the
# package: Node hosts the organs, and the organs do the work.
pkg=node_modules/@ai-ecoverse/hot-glue/dist
for organ in expand as hotglue; do
  test -s "$pkg/$organ.wasm" || { echo "    FAIL: $organ.wasm is not in the tarball" >&2; exit 1; }
done
echo "    the three organs are in the package"

./node_modules/.bin/hotglue -w fizzbuzz.hma > fizzbuzz.wasm
head -c 4 fizzbuzz.wasm | cmp -s - <(printf '\0asm') || {
  echo "    FAIL: -w did not produce a wasm binary" >&2; exit 1; }
echo "    -w assembles, with no wasmtime and no binaryen in reach"

# And the artifact is the one the shipped sources determine, which is the
# thing a consumer cannot check by reading a version number: expand as.hma
# with the shipped toolchain, assemble it with the shipped assembler, and
# the bytes that come out must be the shipped assembler.
printf '(use as.hma)\n' | ./node_modules/.bin/hotglue -w > as-rebuilt.wasm
cmp as-rebuilt.wasm "$pkg/as.wasm" || {
  echo "    FAIL: the shipped assembler is not what the shipped sources assemble to" >&2
  exit 1; }
echo "    the shipped assembler reassembles to itself, byte for byte"

# -O needs the optional binaryen peer, which npm does not install for an
# optional peer and which is therefore absent here. That makes this the one
# place the "it is missing, here is what to do" message can be checked at all.
# Not a pipeline: -O is meant to exit non-zero here, and pipefail would
# read that as the check itself having failed.
set +e
oh_err="$(./node_modules/.bin/hotglue -O fizzbuzz.hma 2>&1 >/dev/null)"
oh_status=$?
set -e
case "$oh_err" in
  *"npm install binaryen"*) ;;
  *) echo "    FAIL: -O did not explain the absent binaryen; it said:" >&2
     printf '%s\n' "$oh_err" >&2
     exit 1 ;;
esac
test "$oh_status" -ne 0 || { echo "    FAIL: -O exited 0 without binaryen" >&2; exit 1; }
echo "    -O without binaryen names the peer, not the resolver's path"


# and the whole way down, if there is a wasmtime here to prove it with
./node_modules/.bin/hotglue fizzbuzz.hma > fizzbuzz.wat
if command -v wasmtime >/dev/null 2>&1; then
  wasmtime fizzbuzz.wat | head -5 | grep -q Fizz
  echo "    fizzbuzz runs under wasmtime"
  wasmtime fizzbuzz.wasm | head -5 | grep -q Fizz
  echo "    and so does the binary the package assembled itself"
else
  echo "    no wasmtime here; the WAT and the binary went unrun"
fi

echo "==> ok"
