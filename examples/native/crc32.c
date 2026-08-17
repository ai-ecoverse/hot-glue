/* CRC-32, the way zlib has computed it since 1995: Gary S. Brown's
 * table algorithm, polynomial 0xEDB88320. This file compiles to a
 * freestanding WebAssembly module with its own memory; the outside
 * world feeds bytes through poke() and asks for the checksum.
 *
 *   clang --target=wasm32 -O2 -nostdlib -Wl,--no-entry \
 *     -Wl,--export=poke -Wl,--export=crc32 \
 *     examples/native/crc32.c -o examples/native/crc32.wasm
 */

static unsigned long table[256];
static int have_table = 0;
static unsigned char BUF[65536];

static void make_table(void) {
  unsigned long c;
  int n, k;
  for (n = 0; n < 256; n++) {
    c = (unsigned long)n;
    for (k = 0; k < 8; k++)
      c = c & 1 ? 0xedb88320UL ^ (c >> 1) : c >> 1;
    table[n] = c;
  }
  have_table = 1;
}

void poke(unsigned i, unsigned char b) { BUF[i & 0xffff] = b; }

unsigned crc32(unsigned len) {
  unsigned long c = 0xffffffffUL;
  unsigned i;
  if (!have_table) make_table();
  for (i = 0; i < len; i++)
    c = table[(c ^ BUF[i & 0xffff]) & 0xff] ^ (c >> 8);
  return (unsigned)(c ^ 0xffffffffUL);
}
