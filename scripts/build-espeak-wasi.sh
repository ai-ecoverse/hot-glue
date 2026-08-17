#!/bin/sh
# build-espeak-wasi.sh — reproduce examples/native/espeak.wasm:
# espeak-ng 1.51.1 compiled against wasi-sdk 25, phonemize-only.
# Data comes from the distro (apt install espeak-ng-data), so the
# native two-stage dictionary build never happens; the async layer
# (event/fifo/espeak_command), mbrola, and speechPlayer stay out;
# system()/tmpnam() are link-time stubs (scripts/wasi-stubs.c).
#
#   sh scripts/build-espeak-wasi.sh /tmp/ffwasi-build
# (share the build dir with build-ffmpeg-wasi.sh to reuse wasi-sdk)
#
#   echo "hello" | wasmtime --dir /usr/lib/x86_64-linux-gnu \
#     examples/native/espeak.wasm /usr/lib/x86_64-linux-gnu en-us
set -e
BUILD=${1:-/tmp/ffwasi-build}
REPO=$(pwd)
mkdir -p "$BUILD"
cd "$BUILD"

[ -d wasi-sdk ] || {
  curl -sSfL -o wasi-sdk.tar.gz https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-25/wasi-sdk-25.0-x86_64-linux.tar.gz
  tar xf wasi-sdk.tar.gz && rm wasi-sdk.tar.gz && mv wasi-sdk-25.0-x86_64-linux wasi-sdk
}
WSDK="$BUILD/wasi-sdk"

[ -d espeak-ng ] || git clone --depth 1 --branch 1.51.1 https://github.com/espeak-ng/espeak-ng.git
mkdir -p espeak-config
echo '#define PACKAGE_VERSION "1.51.1"' > espeak-config/config.h
"$WSDK/bin/clang" --sysroot="$WSDK/share/wasi-sysroot" -O2 \
  -c "$REPO/scripts/wasi-stubs.c" -o wasi-stubs.o
cd espeak-ng
SRCS=$(ls src/libespeak-ng/*.c | grep -vE 'mbrowrap|event|fifo|espeak_command|sPlayer')
"$WSDK/bin/clang" --sysroot="$WSDK/share/wasi-sysroot" \
  -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_GETPID \
  -include "$REPO/scripts/wasi-compat.h" \
  -I"$BUILD/espeak-config" -Isrc/include -Isrc/include/espeak-ng -Isrc/ucd-tools/src/include \
  -O2 -o "$REPO/examples/native/espeak.wasm" \
  $SRCS src/ucd-tools/src/*.c "$REPO/tools/espeak-phonemize/espeak-phonemize.c" "$BUILD/wasi-stubs.o" \
  -lwasi-emulated-signal -lwasi-emulated-process-clocks -lwasi-emulated-mman -lwasi-emulated-getpid
echo "built examples/native/espeak.wasm"
