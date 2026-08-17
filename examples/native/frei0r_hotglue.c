/* frei0r_hotglue.c — a frei0r source plugin with a Lisp inside.
 *
 * ffmpeg dlopens this shared object through its frei0r support; the
 * plugin hosts the nacre-built mandelzoom module via the wasmtime C
 * API and hands each rendered frame to the filter graph. The wasm
 * bytes are embedded at build time, so the .so is self-contained:
 * a WebAssembly module, assembled by an assembler written in the
 * language it assembles, running inside ffmpeg.
 *
 * Build (see npm run build:frei0r):
 *   wasmtime as.wat < mandelzoom.wat > mandelzoom.wasm
 *   xxd -n hotglue_wasm -i mandelzoom.wasm > mandelzoom_wasm.c
 *   clang -O2 -shared -fPIC -I<wasmtime-c-api>/include \
 *     frei0r_hotglue.c mandelzoom_wasm.c <wasmtime-c-api>/lib/libwasmtime.a \
 *     -lpthread -ldl -lm -o hotglue_mandel.so
 * Run:
 *   FREI0R_PATH=<dir> ffmpeg -f lavfi \
 *     -i "frei0r_src=size=256x256:framerate=30:filter_name=hotglue_mandel" \
 *     -t 5 out.mp4
 */
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <wasm.h>
#include <wasmtime.h>

/* the frei0r ABI, declared from its specification so no foreign
 * header needs to travel with this repository */
#define F0R_PLUGIN_TYPE_SOURCE 1
#define F0R_COLOR_MODEL_RGBA8888 1
typedef void *f0r_instance_t;
typedef struct f0r_plugin_info {
  const char *name;
  const char *author;
  int plugin_type;
  int color_model;
  int frei0r_version;
  int major_version;
  int minor_version;
  int num_params;
  const char *explanation;
} f0r_plugin_info_t;

extern const unsigned char hotglue_wasm[];
extern const unsigned int hotglue_wasm_len;

typedef struct {
  int w, h;
  wasm_engine_t *engine;
  wasmtime_store_t *store;
  wasmtime_context_t *ctx;
  wasmtime_func_t frame;
  wasmtime_memory_t mem;
  int ok;
} nacre_t;

int f0r_init(void) { return 1; }
void f0r_deinit(void) {}

void f0r_get_plugin_info(f0r_plugin_info_t *info) {
  info->name = "hotglue_mandel";
  info->author = "the allegorithm oyster";
  info->plugin_type = F0R_PLUGIN_TYPE_SOURCE;
  info->color_model = F0R_COLOR_MODEL_RGBA8888;
  info->frei0r_version = 1;
  info->major_version = 0;
  info->minor_version = 1;
  info->num_params = 0;
  info->explanation = "Mandelbrot zoom rendered by a WebAssembly Lisp";
}

void f0r_get_param_info(void *info, int index) { (void)info; (void)index; }
void f0r_set_param_value(f0r_instance_t inst, void *p, int i) { (void)inst; (void)p; (void)i; }
void f0r_get_param_value(f0r_instance_t inst, void *p, int i) { (void)inst; (void)p; (void)i; }

f0r_instance_t f0r_construct(unsigned int width, unsigned int height) {
  nacre_t *n = calloc(1, sizeof(nacre_t));
  if (!n) return NULL;
  n->w = (int)width;
  n->h = (int)height;
  n->engine = wasm_engine_new();
  n->store = wasmtime_store_new(n->engine, NULL, NULL);
  n->ctx = wasmtime_store_context(n->store);

  wasmtime_module_t *module = NULL;
  if (wasmtime_module_new(n->engine, hotglue_wasm, hotglue_wasm_len, &module)) return n;

  wasmtime_linker_t *linker = wasmtime_linker_new(n->engine);
  wasmtime_linker_define_wasi(linker);
  wasi_config_t *wasi = wasi_config_new();
  wasmtime_context_set_wasi(n->ctx, wasi);

  wasmtime_instance_t instance;
  wasm_trap_t *trap = NULL;
  if (wasmtime_linker_instantiate(linker, n->ctx, module, &instance, &trap)) return n;

  wasmtime_extern_t item;
  if (!wasmtime_instance_export_get(n->ctx, &instance, "frame", 5, &item) ||
      item.kind != WASMTIME_EXTERN_FUNC)
    return n;
  n->frame = item.of.func;
  if (!wasmtime_instance_export_get(n->ctx, &instance, "memory", 6, &item) ||
      item.kind != WASMTIME_EXTERN_MEMORY)
    return n;
  n->mem = item.of.memory;
  n->ok = 1;
  return n;
}

void f0r_destruct(f0r_instance_t inst) {
  nacre_t *n = inst;
  if (n->store) wasmtime_store_delete(n->store);
  if (n->engine) wasm_engine_delete(n->engine);
  free(n);
}

void f0r_update(f0r_instance_t inst, double time, const uint32_t *in, uint32_t *out) {
  nacre_t *n = inst;
  (void)in;
  if (!n->ok) return;
  int fr = (int)(time * 30.0 + 0.5);
  if (fr > 149) fr = 149;

  wasmtime_val_t arg = { .kind = WASMTIME_I32, .of = { .i32 = fr } };
  wasmtime_val_t ret;
  wasm_trap_t *trap = NULL;
  if (wasmtime_func_call(n->ctx, &n->frame, &arg, 1, &ret, 1, &trap)) return;

  const uint8_t *rgb = wasmtime_memory_data(n->ctx, &n->mem) + ret.of.i32;
  uint8_t *dst = (uint8_t *)out;
  for (int y = 0; y < n->h; y++) {
    int sy = y * 256 / n->h;
    for (int x = 0; x < n->w; x++) {
      int sx = x * 256 / n->w;
      const uint8_t *px = rgb + (sy * 256 + sx) * 3;
      *dst++ = px[0];
      *dst++ = px[1];
      *dst++ = px[2];
      *dst++ = 0xff;
    }
  }
}
