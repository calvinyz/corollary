# Image to LaTeX on device: GLM-OCR spike

**Verdict: GO.** GLM-OCR runs in Swift through MLX (`mlx-swift-lm`), with no Ollama, and is accurate enough for the MVP's paste-an-equation feature.

Run: October 31, 2026, on an M1 Max (64 GB) with macOS 27.2. The model was `mlx-community/GLM-OCR-4bit` (revision `97f5875`, 1.2 GB) with the prompt `Formula Recognition:` and greedy decoding. Packages were pinned to `mlx-swift-lm` 3.32.3, `swift-huggingface` 0.13.0 and `swift-transformers` 1.3.5.

| Set | Correct (ignoring spacing, braces and `\left`/`\right`) |
|---|---|
| Handwritten (CROHME-style, `linxy/LaTeX_OCR` human_handwrite split) | 6 / 8 |
| Printed | 3 / 3 |

The two misses: `1!` read as `11` (the handwriting is genuinely ambiguous), and a dropped `+0` in a limit subscript.

| | |
|---|---|
| Warm inference | 0.17–0.49 s per image |
| Model load | about 0.4 s (weights load lazily) |
| First inference after install or update | 4–6 s while Metal shaders compile |
| Peak memory | about 2.1 GB footprint (1.4 GB RSS) |

**Both APIs work and give identical output:** MLXVLM's `ModelContainer`, and Foundation Models' `MLXLanguageModel(.vision)` with `LanguageModelSession`. Use the MLXVLM path, since it runs on macOS 14+; the Foundation Models path needs macOS 27.

## For the helper

- Set `processing.resize = nil`. `ChatSession` otherwise squashes images to 512×512.
- Strip the `$$…$$` the model wraps around its output.
- Download the weights on first use into Application Support, pinned to a revision and checked by sha256, rather than bundling them.
- Ship and sign `mlx-swift_Cmlx.bundle` (`default.metallib`) next to the helper binary. Without it the model fails with "Failed to load the default metallib".
- Building needs `xcodebuild` and the Metal Toolchain component, locally and in CI.

## Not yet tested

- Hardened runtime and notarization with Metal shader compilation inside a signed sidecar.
- Photos from a phone camera (perspective, lighting, multi-line work). The test images are clean crops, so they flatter the model.
- A comparison against PaddleOCR-VL.
