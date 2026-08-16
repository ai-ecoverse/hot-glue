// zeroperl-run.mjs — run one Perl script inside the zeroperl wasm
// sandbox and print its output. A capability, not a conductor.
//
//   node scripts/zeroperl-run.mjs script.pl
import { readFileSync } from 'node:fs';

const { ZeroPerl } = await import('@6over3/zeroperl-ts');
let out = '';
const perl = await ZeroPerl.create({ stdout: (s) => (out += s) });
await perl.eval(readFileSync(process.argv[2], 'utf8'));
perl.flush();
process.stdout.write(out.trim());
