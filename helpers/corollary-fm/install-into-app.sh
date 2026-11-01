#!/bin/bash
# Copies a built helper into the desktop app's src-tauri/binaries for bundling.
set -euo pipefail
cd "$(dirname "$0")"
src=.build/release-xc
dest=../../apps/desktop/src-tauri/binaries
mkdir -p "$dest"
cp "$src/corollary-fm" "$dest/corollary-fm-aarch64-apple-darwin"
cp "$src/libswiftCompatibilitySpan.dylib" "$dest/"
rm -rf "$dest/mlx-swift_Cmlx.bundle" && cp -R "$src/mlx-swift_Cmlx.bundle" "$dest/"
echo "installed into $dest"
