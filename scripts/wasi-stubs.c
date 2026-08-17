/* wasi-stubs.c — symbols libc headers mention and WASI cannot supply.
   system() has no shell to reach; tmpnam() hands out one fixed name
   in the current preopen. */
#include <stddef.h>
#include <string.h>
int system(const char *cmd) { (void)cmd; return -1; }
char *tmpnam(char *buf) {
  static char fixed[] = "./wasi-tmpnam";
  if (!buf) return fixed;
  strcpy(buf, fixed);
  return buf;
}
