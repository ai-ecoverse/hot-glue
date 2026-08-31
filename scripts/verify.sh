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
    for (const name of ["compile", "loadSource", "lookupPath", "resolveUses"]) {
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

# and the whole way down, if there is a wasmtime here to prove it with
./node_modules/.bin/hotglue fizzbuzz.hma > fizzbuzz.wat
if command -v wasmtime >/dev/null 2>&1; then
  wasmtime fizzbuzz.wat | head -5 | grep -q Fizz
  echo "    fizzbuzz runs under wasmtime"
else
  echo "    no wasmtime here; expanded to WAT only"
fi

echo "==> ok"
