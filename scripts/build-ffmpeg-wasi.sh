#!/bin/sh
# build-ffmpeg-wasi.sh — reproduce examples/native/ffmpeg.wasm:
# ffmpeg n5.1.6 + x264, compiled against wasi-sdk 25, running under
# any WASI runtime. No Emscripten, no JS runtime, no threads — n5.1
# is the last major with a threadless ffmpeg CLI (6.x hard-requires
# threads for its transcode pipeline).
#
# The seams, for the next traveler: wasi-libc lacks dup/tempnam
# (shimmed in scripts/wasi-compat.h), declares-but-does-not-define
# madvise (link-time stub below), and spells memalign aligned_alloc.
# x264's config.guess predates wasm — cross-build as --host=i386-linux
# with clang doing the real targeting. The host strip chokes on wasm:
# STRIP=true, and ffmpeg_g is the artifact.
#
#   sh scripts/build-ffmpeg-wasi.sh /tmp/ffwasi-build
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
COMPAT="$REPO/scripts/wasi-compat.h"

cat > madvise-stub.c <<'EOF'
#include <stddef.h>
int madvise(void *addr, size_t len, int advice) {
  (void)addr; (void)len; (void)advice;
  return 0;
}
EOF
"$WSDK/bin/clang" --sysroot="$WSDK/share/wasi-sysroot" -D_WASI_EMULATED_MMAN -O2 -c madvise-stub.c -o madvise-stub.o

[ -d x264 ] || git clone --depth 1 https://code.videolan.org/videolan/x264.git x264
cd x264
CC="$WSDK/bin/clang --sysroot=$WSDK/share/wasi-sysroot" AR="$WSDK/bin/ar" RANLIB="$WSDK/bin/ranlib" \
  ./configure --host=i386-linux \
  --extra-cflags="-D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_MMAN -include $COMPAT" \
  --extra-ldflags="-lwasi-emulated-signal -lwasi-emulated-process-clocks -lwasi-emulated-mman" \
  --disable-asm --disable-thread --disable-opencl --enable-static --disable-cli --prefix="$BUILD/x264-out"
make -j"$(nproc)" && make install
cd "$BUILD"

[ -d ffmpeg5 ] || git clone --depth 1 --branch n5.1.6 https://github.com/FFmpeg/FFmpeg.git ffmpeg5
cd ffmpeg5
PKG_CONFIG_PATH="$BUILD/x264-out/lib/pkgconfig" ./configure \
  --target-os=none --arch=c --enable-cross-compile --pkg-config-flags="--static" \
  --cc="$WSDK/bin/clang" --cxx="$WSDK/bin/clang++" --ar="$WSDK/bin/ar" --ranlib="$WSDK/bin/ranlib" --nm="$WSDK/bin/nm" \
  --sysroot="$WSDK/share/wasi-sysroot" \
  --extra-cflags="-D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_GETPID -O2 -include $COMPAT -I$BUILD/x264-out/include" \
  --extra-ldflags="-lwasi-emulated-signal -lwasi-emulated-process-clocks -lwasi-emulated-mman -lwasi-emulated-getpid -L$BUILD/x264-out/lib $BUILD/madvise-stub.o" \
  --disable-asm --disable-x86asm --disable-inline-asm \
  --disable-pthreads --disable-w32threads --disable-os2threads \
  --disable-network --disable-doc --disable-debug --disable-autodetect \
  --disable-avdevice --disable-postproc \
  --disable-everything --enable-gpl --enable-libx264 \
  --enable-demuxer=yuv4mpegpipe,wav,mov,mp4,m4a \
  --enable-muxer=mp4,yuv4mpegpipe,wav \
  --enable-decoder=rawvideo,pcm_s16le,aac,mpeg4,h264 \
  --enable-encoder=mpeg4,aac,rawvideo,pcm_s16le,libx264 \
  --enable-filter=scale,aresample,hstack,vstack,overlay,format \
  --enable-protocol=file,pipe \
  --enable-swscale --enable-swresample
make -j"$(nproc)" STRIP=true
cp ffmpeg_g "$REPO/examples/native/ffmpeg.wasm"
echo "built examples/native/ffmpeg.wasm — try:"
echo "  wasmtime --dir .::/work examples/native/ffmpeg.wasm -nostdin -i /work/in.y4m -c:v libx264 -c:a aac /work/out.mp4"
