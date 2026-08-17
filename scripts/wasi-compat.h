/* wasi-compat.h — the half-dozen POSIX stragglers ffmpeg mentions
   and WASI does not provide. Stubs that fail politely at runtime;
   the code paths that call them are not on the film's route. */
#ifndef WASI_COMPAT_H
#define WASI_COMPAT_H
#include <errno.h>
static inline int wasi_no_dup(int fd) { (void)fd; errno = ENOTSUP; return -1; }
#define dup wasi_no_dup

/* tempnam: WASI has no temp-name oracle; hand out a fixed name in
   the current preopen and let open() succeed or fail honestly. */
#include <stdlib.h>
#include <string.h>
static inline char *wasi_tempnam(const char *dir, const char *pfx) {
  (void)dir; (void)pfx;
  char *s = (char *)malloc(32);
  if (s) strcpy(s, "./wasi-tmpfile");
  return s;
}
#define tempnam wasi_tempnam
/* x264 asks for memalign; wasi-libc offers aligned_alloc */
static inline void *wasi_memalign(unsigned long a, unsigned long n) { return aligned_alloc(a, n); }
#define memalign wasi_memalign
#endif
