# corollary-fm

A small helper that serves Apple's on-device model and GLM-OCR (via MLX) over a loopback,
OpenAI-compatible API. The desktop app starts it as a sidecar.

| Route | |
|---|---|
| `GET /health` | Apple model availability and context size; OCR model state |
| `GET /v1/models` | `apple-on-device` when available |
| `POST /v1/chat/completions` | OpenAI chat, streaming or not |
| `POST /v1/ocr` | `{"image": base64, "kind": "formula" \| "text" \| "table"}` → `{"latex"}` |
| `POST /v1/ocr/download` | Starts the one-time 1.2 GB model download |

It binds to 127.0.0.1 only and, when `COROLLARY_FM_TOKEN` is set, requires it as a bearer token.

## Building

Needs Xcode 26.4 or later (the FoundationModels SDK; tested with 27.2) and the
Metal Toolchain component. MLX's shaders
only build through `xcodebuild`:

```bash
./build.sh            # → .build/release-xc/corollary-fm + mlx-swift_Cmlx.bundle
```

The binary runs on macOS 14+. The Apple model needs macOS 26+ with Apple Intelligence on.
