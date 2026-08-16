/**
 * Binaryen as the alternate lowering (docs/wasm-macros.md § 9, stage 5).
 *
 * Parse the WAT Hot Glue prints into Binaryen IR, optimize, emit a binary.
 * The feature set is curated: Features.All turns on encodings (compact
 * imports, among others) that shipping runtimes do not speak yet.
 */
import binaryen from 'binaryen';

const F = binaryen.Features;
const FEATURES =
  F.GC |
  F.ReferenceTypes |
  F.BulkMemory |
  F.BulkMemoryOpt |
  F.MutableGlobals |
  F.SignExt |
  F.Multivalue |
  F.NontrappingFPToInt |
  F.CallIndirectOverlong;

export function lower(wat: string, optimize = true): Uint8Array {
  const m = binaryen.parseText(wat);
  m.setFeatures(FEATURES);
  if (optimize) {
    binaryen.setOptimizeLevel(2);
    binaryen.setShrinkLevel(1);
    m.optimize();
  }
  if (!m.validate()) {
    m.dispose();
    throw new Error('binaryen: module does not validate');
  }
  const binary = m.emitBinary();
  m.dispose();
  return binary;
}
