/* espeak-phonemize.c — text on stdin, IPA phonemes on stdout.
   The whole program is the phonemizer capability: espeak-ng compiled
   to WASI, data from a preopened directory. */
#include <espeak-ng/espeak_ng.h>
#include <espeak-ng/speak_lib.h>
#include <stdio.h>
#include <string.h>

int main(int argc, char **argv) {
    const char *data = argc > 1 ? argv[1] : "/usr/lib/x86_64-linux-gnu";
    const char *voice = argc > 2 ? argv[2] : "en-us";
    espeak_ng_InitializePath(data);
    espeak_ng_ERROR_CONTEXT ctx = NULL;
    if (espeak_ng_Initialize(&ctx) != ENS_OK) { fprintf(stderr, "espeak: init failed\n"); return 1; }
    if (espeak_ng_SetVoiceByName(voice) != ENS_OK) { fprintf(stderr, "espeak: no voice %s\n", voice); return 2; }
    static char text[65536];
    size_t n = fread(text, 1, sizeof text - 1, stdin);
    text[n] = 0;
    const void *p = text;
    while (p) {
        const char *ph = espeak_TextToPhonemes(&p, espeakCHARS_UTF8, espeakPHONEMES_IPA);
        if (ph && *ph) printf("%s ", ph);
    }
    printf("\n");
    return 0;
}
