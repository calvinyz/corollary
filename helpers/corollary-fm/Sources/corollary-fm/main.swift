// corollary-fm: Apple's on-device model and GLM-OCR behind a loopback, OpenAI-compatible API.
//
//   corollary-fm [--port N] [--models-dir DIR] [--exit-with-stdin]
//
// Prints `{"port": N}` on the first stdout line once listening. Requests must carry
// `Authorization: Bearer $COROLLARY_FM_TOKEN` when that variable is set.
import Foundation

let version = "0.1.0"
let appleModelID = "apple-on-device"

func option(_ name: String) -> String? {
    let args = CommandLine.arguments
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

let port = UInt16(option("--port") ?? "0") ?? 0
let modelsDir = option("--models-dir").map { URL(fileURLWithPath: $0) }
    ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("io.github.calvinyz.corollary/models")
let token = ProcessInfo.processInfo.environment["COROLLARY_FM_TOKEN"].flatMap { $0.isEmpty ? nil : $0 }
let ocr = OCR(modelsDir: modelsDir)

func handle(_ req: Request, _ res: Response) async {
    switch (req.method, req.path) {
    case ("GET", "/health"):
        await res.json(200, ["version": version, "apple": AppleModel.status(), "ocr": await ocr.status()])

    case ("GET", "/v1/models"):
        let ok = AppleModel.status()["available"] as? Bool == true
        await res.json(200, ["object": "list", "data": ok ? [["id": appleModelID, "object": "model", "owned_by": "apple"]] : []])

    case ("POST", "/v1/chat/completions"):
        await chat(req, res)

    case ("POST", "/v1/ocr"):
        guard let body = req.json(), let b64 = body["image"] as? String, let image = Data(base64Encoded: b64) else {
            return await res.error(400, "expected {\"image\": base64}")
        }
        do {
            let latex = try await ocr.recognize(image, kind: body["kind"] as? String ?? "formula")
            await res.json(200, ["latex": latex])
        } catch let e as HelperError {
            await res.error(e.status, e.message, code: e.code)
        } catch {
            await res.error(500, String(describing: error))
        }

    case ("POST", "/v1/ocr/download"):
        await ocr.startDownload()
        await res.json(200, await ocr.status())

    default:
        await res.error(404, "no route for \(req.method) \(req.path)")
    }
}

func chat(_ req: Request, _ res: Response) async {
    guard let body = req.json(), let messages = ChatMessage.parse(body["messages"]) else {
        return await res.error(400, "expected OpenAI chat messages")
    }
    guard #available(macOS 26, *) else {
        return await res.error(503, "Apple's on-device model needs macOS 26 or later.", code: "model_unavailable")
    }
    let stream = body["stream"] as? Bool ?? false
    let id = "chatcmpl-\(UUID().uuidString.prefix(12))"
    let created = Int(Date().timeIntervalSince1970)
    let chunk = { (delta: [String: Any], finish: String?) -> [String: Any] in
        ["id": id, "object": "chat.completion.chunk", "created": created, "model": appleModelID,
         "choices": [["index": 0, "delta": delta, "finish_reason": finish as Any]]]
    }
    do {
        let text = try await AppleModel.complete(
            messages: messages,
            maxTokens: body["max_tokens"] as? Int ?? body["max_completion_tokens"] as? Int,
            temperature: body["temperature"] as? Double
        ) { delta in
            if stream { await res.event(chunk(["content": delta], nil)) }
        }
        if stream {
            await res.event(chunk([:], "stop"))
            await res.endEvents()
        } else {
            await res.json(200, [
                "id": id, "object": "chat.completion", "created": created, "model": appleModelID,
                "choices": [["index": 0, "message": ["role": "assistant", "content": text], "finish_reason": "stop"]],
            ])
        }
    } catch let e as HelperError {
        if stream {
            await res.event(["error": ["message": e.message, "code": e.code]])
            await res.endEvents()
        } else {
            await res.error(e.status, e.message, code: e.code)
        }
    } catch {
        // Once streaming has started the status line is sent; report the error in the stream.
        if stream {
            await res.event(["error": ["message": String(describing: error), "code": "generation_failed"]])
            await res.endEvents()
        } else {
            await res.error(500, String(describing: error))
        }
    }
}

setvbuf(stdout, nil, _IOLBF, 0)
do {
    let server = try Server(port: port, token: token) { req, res in await handle(req, res) }
    let bound = try await server.start()
    print("{\"port\": \(bound)}")
    if CommandLine.arguments.contains("--exit-with-stdin") {
        // stdin closes when the parent app quits or crashes.
        Thread.detachNewThread {
            while FileHandle.standardInput.availableData.count > 0 {}
            exit(0)
        }
    }
    while true { try await Task.sleep(for: .seconds(3600)) }
} catch {
    FileHandle.standardError.write(Data("corollary-fm: \(error)\n".utf8))
    exit(1)
}
