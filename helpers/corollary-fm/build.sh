#!/bin/bash
# Builds a release helper with the MLX metallib bundle next to it.
set -euo pipefail
cd "$(dirname "$0")"
out=.build/release-xc
xcodebuild build -scheme corollary-fm -configuration Release -destination 'platform=macOS,arch=arm64' \
  -derivedDataPath .build/dd -skipMacroValidation CLANG_ENABLE_CODE_COVERAGE=NO CLANG_COVERAGE_MAPPING=NO ${CLONED_PACKAGES:+-clonedSourcePackagesDirPath "$CLONED_PACKAGES"} -quiet
products=.build/dd/Build/Products/Release
rm -rf "$out" && mkdir -p "$out"
cp "$products/corollary-fm" "$out/"
cp -R "$products/mlx-swift_Cmlx.bundle" "$out/"
# Swift 6.2+ code needs this on macOS releases older than 26.
cp "$(xcode-select -p)/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift-6.2/macosx/libswiftCompatibilitySpan.dylib" "$out/"
echo "$out"
