import CryptoKit
import Foundation
import HuggingFace
import MLXHuggingFace
import MLXLMCommon
import MLXVLM
import Tokenizers

/// GLM-OCR through MLX. Weights download on first use, pinned to a revision and checked by SHA-256.
actor OCR {
    static let repo = "mlx-community/GLM-OCR-4bit"
    static let revision = "97f587506984cc92fa69b2694b4128e53db6b081"
    static let files: [(name: String, sha256: String, size: Int64)] = [
        ("config.json", "c5c23ce928b8ccd72468c36de821a4132091e7bfc8dc3011e4349acafa63b72a", 2080),
        ("generation_config.json", "4e2a3412f65b2a21d315d928986c55723d3e60dfb92c3982a5b9fd56835b0aa5", 165),
        ("chat_template.jinja", "062e7ee4cc8defa88a5938b5d456dc60366ffd80647f918946ee747bf09ddc7c", 4606),
        ("preprocessor_config.json", "02cc50c36240882ae35e8cd4077a25a379664108185d728d261cb785aefeccff", 367),
        ("processor_config.json", "19dafea5bd6415c50e2da43a31583dab39f9496673260ad33d9fa6c638a1d077", 597),
        ("tokenizer_config.json", "7a76fcb27abbc2cb0249d81884fef972b2c27194e3e13db54baae50f58f141fb", 1066),
        ("tokenizer.json", "aa0fd058c73a5718bb191f6672dc16d122ee0147b20c123d1726514298f9968a", 6_838_609),
        ("model.safetensors.index.json", "191dea2bf69e8d0ec156ce87be21044ae28a1dd6a3418a35b2df4b36478daa39", 55990),
        ("model.safetensors", "089e0339fcbc0fbf2225c3bd1cd94c6b4d49fdb3b1adfbb35ea22eb60b2afc95", 1_247_191_941),
    ]
    static let prompts = ["formula": "Formula Recognition:", "text": "Text Recognition:", "table": "Table Recognition:"]
    static let idleUnload: TimeInterval = 600

    enum State {
        case missing
        case downloading(done: Int64)
        case ready
        case failed(String)
    }

    let dir: URL
    private var state: State
    private var container: ModelContainer?
    private var lastUse = Date()

    init(modelsDir: URL) {
        dir = modelsDir.appendingPathComponent("GLM-OCR-4bit-\(Self.revision.prefix(7))")
        state = FileManager.default.fileExists(atPath: dir.appendingPathComponent(".complete").path) ? .ready : .missing
    }

    static var totalBytes: Int64 { files.reduce(0) { $0 + $1.size } }

    func status() -> [String: Any] {
        var s: [String: Any] = ["model": Self.repo, "bytes": Self.totalBytes, "loaded": container != nil]
        switch state {
        case .missing: s["state"] = "missing"
        case .downloading(let done): s["state"] = "downloading"; s["downloaded"] = done
        case .ready: s["state"] = "ready"
        case .failed(let msg): s["state"] = "failed"; s["error"] = msg
        }
        return s
    }

    func startDownload() {
        switch state {
        case .missing, .failed: break
        default: return
        }
        state = .downloading(done: 0)
        Task { await self.download() }
    }

    private func setProgress(_ done: Int64) {
        if case .downloading = state { state = .downloading(done: done) }
    }

    private func download() async {
        let fm = FileManager.default
        let partial = dir.appendingPathExtension("partial")
        do {
            try fm.createDirectory(at: partial, withIntermediateDirectories: true)
            var finished: Int64 = 0
            for file in Self.files {
                let dest = partial.appendingPathComponent(file.name)
                if fm.fileExists(atPath: dest.path), (try? sha256(of: dest)) == file.sha256 {
                    finished += file.size
                    setProgress(finished)
                    continue
                }
                let url = URL(string: "https://huggingface.co/\(Self.repo)/resolve/\(Self.revision)/\(file.name)")!
                let base = finished
                let tmp = try await Downloader.fetch(url) { bytes in
                    Task { self.setProgress(base + bytes) }
                }
                guard try sha256(of: tmp) == file.sha256 else {
                    try? fm.removeItem(at: tmp)
                    throw HelperError(status: 500, code: "checksum", message: "\(file.name) failed its checksum")
                }
                try? fm.removeItem(at: dest)
                try fm.moveItem(at: tmp, to: dest)
                finished += file.size
                setProgress(finished)
            }
            fm.createFile(atPath: partial.appendingPathComponent(".complete").path, contents: Data())
            try? fm.removeItem(at: dir)
            try fm.moveItem(at: partial, to: dir)
            state = .ready
        } catch {
            state = .failed((error as? HelperError)?.message ?? error.localizedDescription)
        }
    }

    func recognize(_ image: Data, kind: String) async throws -> String {
        guard case .ready = state else {
            throw HelperError(status: 409, code: "model_missing", message: "The image-to-LaTeX model isn't downloaded yet.")
        }
        guard let prompt = Self.prompts[kind] else {
            throw HelperError(status: 400, code: "bad_kind", message: "kind must be formula, text or table")
        }
        lastUse = Date()
        let container = try await loaded()
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("corollary-ocr-\(UUID().uuidString)")
        try image.write(to: tmp)
        defer { try? FileManager.default.removeItem(at: tmp) }
        // The default processing squashes images to 512×512; let the GLM processor size them.
        var processing = UserInput.Processing()
        processing.resize = nil
        let session = ChatSession(container, generateParameters: GenerateParameters(maxTokens: 512, temperature: 0), processing: processing)
        let out = try await session.respond(to: prompt, image: .url(tmp))
        lastUse = Date()
        scheduleUnload()
        return cleanLatex(out)
    }

    private func loaded() async throws -> ModelContainer {
        if let container { return container }
        let c = try await loadModelContainer(from: dir, using: #huggingFaceTokenizerLoader())
        container = c
        return c
    }

    /// Frees the ~2 GB model after it sits unused.
    private func scheduleUnload() {
        Task {
            try? await Task.sleep(for: .seconds(Self.idleUnload + 1))
            if Date().timeIntervalSince(self.lastUse) >= Self.idleUnload { self.unload() }
        }
    }

    private func unload() { container = nil }
}

/// Strips the `$$…$$` or `\[…\]` wrapper the model puts around formulas.
func cleanLatex(_ s: String) -> String {
    var t = s.trimmingCharacters(in: .whitespacesAndNewlines)
    for (open, close) in [("$$", "$$"), ("\\[", "\\]"), ("$", "$")] where t.hasPrefix(open) && t.hasSuffix(close) && t.count > open.count + close.count {
        let inner = String(t.dropFirst(open.count).dropLast(close.count))
        // `$a$ and $b$` is text with two formulas, not one wrapped formula.
        if inner.contains(open) || inner.contains(close) { break }
        t = inner.trimmingCharacters(in: .whitespacesAndNewlines)
        break
    }
    return t
}

func sha256(of url: URL) throws -> String {
    let h = try FileHandle(forReadingFrom: url)
    defer { try? h.close() }
    var hasher = SHA256()
    while let chunk = try h.read(upToCount: 8 << 20), !chunk.isEmpty { hasher.update(data: chunk) }
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
}

final class Downloader: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    private let progress: (Int64) -> Void
    private var continuation: CheckedContinuation<URL, Error>?

    private init(progress: @escaping (Int64) -> Void) { self.progress = progress }

    static func fetch(_ url: URL, progress: @escaping (Int64) -> Void) async throws -> URL {
        let d = Downloader(progress: progress)
        let session = URLSession(configuration: .ephemeral, delegate: d, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        return try await withCheckedThrowingContinuation { c in
            d.continuation = c
            session.downloadTask(with: url).resume()
        }
    }

    func urlSession(_ s: URLSession, downloadTask: URLSessionDownloadTask, didWriteData _: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite _: Int64) {
        progress(totalBytesWritten)
    }

    func urlSession(_ s: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        if let http = downloadTask.response as? HTTPURLResponse, http.statusCode != 200 {
            continuation?.resume(throwing: HelperError(status: 502, code: "download", message: "HTTP \(http.statusCode) for \(downloadTask.originalRequest?.url?.lastPathComponent ?? "")"))
            continuation = nil
            return
        }
        // The system deletes `location` when this returns.
        let keep = FileManager.default.temporaryDirectory.appendingPathComponent("corollary-dl-\(UUID().uuidString)")
        do {
            try FileManager.default.moveItem(at: location, to: keep)
            continuation?.resume(returning: keep)
        } catch {
            continuation?.resume(throwing: error)
        }
        continuation = nil
    }

    func urlSession(_ s: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error {
            continuation?.resume(throwing: error)
            continuation = nil
        }
    }
}
