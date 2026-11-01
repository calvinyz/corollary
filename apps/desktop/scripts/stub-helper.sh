#!/bin/bash
# Placeholder sidecar files so the app builds without Xcode 26.4+. The app then reports the
# on-device AI as unavailable. Build the real helper with helpers/corollary-fm/build.sh.
set -euo pipefail
dest="$(dirname "$0")/../src-tauri/binaries"
mkdir -p "$dest/mlx-swift_Cmlx.bundle"
[ -e "$dest/corollary-fm-aarch64-apple-darwin" ] || { printf '#!/bin/sh\nexit 1\n' > "$dest/corollary-fm-aarch64-apple-darwin"; chmod +x "$dest/corollary-fm-aarch64-apple-darwin"; }
[ -e "$dest/libswiftCompatibilitySpan.dylib" ] || touch "$dest/libswiftCompatibilitySpan.dylib"
