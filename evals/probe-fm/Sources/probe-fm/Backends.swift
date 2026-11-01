import Foundation
import FoundationModels

struct Completion {
    var text: String?
    var error: String?
    var seconds: Double
    var retried = false
}

struct Diagnosis: Codable {
    var line: Int
    var cause: String
    var fixedLine: String
}

protocol Backend {
    var name: String { get }
    func complete(system: String, user: String) async -> Completion
    func diagnose(system: String, user: String) async -> (Diagnosis?, Completion)
}

// MARK: - Apple on-device model

@Generable
struct LatexEdit {
    @Guide(description: "The edited LaTeX excerpt only. Keep every LaTeX command, math expression, citation key, reference key and label exactly as in the input.")
    var replacement: String
}

@Generable
struct ErrorDiagnosis {
    @Guide(description: "The line number in the numbered source where the error originates.")
    var line: Int
    @Guide(description: "One sentence explaining the cause of the error.")
    var cause: String
    @Guide(description: "The corrected version of that source line, as verbatim LaTeX.")
    var fixedLine: String
}

struct AppleFM: Backend {
    var permissiveGuardrails = false
    var name: String { permissiveGuardrails ? "apple-fm (permissive guardrails)" : "apple-fm" }

    func model() -> SystemLanguageModel {
        permissiveGuardrails
            ? SystemLanguageModel(useCase: .general, guardrails: .permissiveContentTransformations)
            : SystemLanguageModel.default
    }

    static func availability() -> String? {
        switch SystemLanguageModel.default.availability {
        case .available: return nil
        case .unavailable(let reason): return String(describing: reason)
        }
    }

    static var contextSize: Int { SystemLanguageModel.default.contextSize }

    /// Tokens the model would use for `text`, so callers can trim input before sending.
    static func tokenCount(_ text: String) async -> Int? {
        try? await SystemLanguageModel.default.tokenCount(for: text)
    }

    /// Cap output so a runaway generation fails fast instead of filling the 4K context
    /// (seen with @Generable: 300–426s before erroring).
    static let maxEditTokens = 1024
    private var options: GenerationOptions {
        GenerationOptions(temperature: 0.2, maximumResponseTokens: Self.maxEditTokens)
    }

    /// The framework occasionally fails with an unexplained `LanguageModelError -1`; retry that once.
    private static func isTransient(_ error: Error) -> Bool {
        let ns = error as NSError
        return ns.domain.hasPrefix("FoundationModels") && ns.code == -1
    }

    private func run<T>(system: String, _ body: (LanguageModelSession) async throws -> T) async -> (T?, Completion) {
        let start = Date()
        var retried = false
        while true {
            let session = LanguageModelSession(model: model(), instructions: system)
            do {
                let value = try await body(session)
                return (value, Completion(text: nil, error: nil, seconds: Date().timeIntervalSince(start), retried: retried))
            } catch {
                if !retried && Self.isTransient(error) { retried = true; continue }
                return (nil, Completion(text: nil, error: String(describing: error), seconds: Date().timeIntervalSince(start), retried: retried))
            }
        }
    }

    func complete(system: String, user: String) async -> Completion {
        let (text, c) = await run(system: system) { try await $0.respond(to: user, options: options).content }
        return Completion(text: text, error: c.error, seconds: c.seconds, retried: c.retried)
    }

    /// Same edit, but with guided generation (@Generable) instead of free text.
    func completeStructured(system: String, user: String) async -> Completion {
        let (text, c) = await run(system: system) {
            try await $0.respond(to: user, generating: LatexEdit.self, options: options).content.replacement
        }
        return Completion(text: text, error: c.error, seconds: c.seconds, retried: c.retried)
    }

    func diagnose(system: String, user: String) async -> (Diagnosis?, Completion) {
        let (d, c) = await run(system: system) { session -> Diagnosis in
            let r = try await session.respond(to: user, generating: ErrorDiagnosis.self, options: options)
            return Diagnosis(line: r.content.line, cause: r.content.cause, fixedLine: r.content.fixedLine)
        }
        return (d, Completion(text: d.map { "\($0)" }, error: c.error, seconds: c.seconds, retried: c.retried))
    }

    /// Seconds until the first streamed chunk arrives. With `prewarm`, the session is warmed
    /// first (as the app would when the ⌘K bar opens) and the warm-up time is excluded.
    func timeToFirstToken(system: String, user: String, prewarm: Bool) async -> Double? {
        let session = LanguageModelSession(model: model(), instructions: system)
        if prewarm {
            session.prewarm()
            try? await Task.sleep(for: .seconds(2))
        }
        let start = Date()
        do {
            for try await _ in session.streamResponse(to: user, options: options) {
                return Date().timeIntervalSince(start)
            }
        } catch { return nil }
        return nil
    }
}

// MARK: - Ollama (or any OpenAI-compatible server) as the baseline

struct OpenAICompatible: Backend {
    let baseURL: String   // e.g. http://localhost:11434
    let model: String
    var name: String { "ollama:\(model)" }

    private func chat(system: String, user: String, json: Bool) async -> Completion {
        let start = Date()
        guard let url = URL(string: baseURL.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/v1/chat/completions") else {
            return Completion(text: nil, error: "bad URL", seconds: 0)
        }
        var body: [String: Any] = [
            "model": model,
            "temperature": 0.2,
            "stream": false,
            "messages": [["role": "system", "content": system], ["role": "user", "content": user]],
        ]
        if json { body["response_format"] = ["type": "json_object"] }
        var req = URLRequest(url: url, timeoutInterval: 600)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            let secs = Date().timeIntervalSince(start)
            if let http = resp as? HTTPURLResponse, http.statusCode != 200 {
                return Completion(text: nil, error: "HTTP \(http.statusCode): \(String(decoding: data, as: UTF8.self))", seconds: secs)
            }
            let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            let choices = obj?["choices"] as? [[String: Any]]
            let msg = choices?.first?["message"] as? [String: Any]
            var content = msg?["content"] as? String ?? ""
            // Drop <think>...</think> blocks some reasoning models emit.
            if let r = content.range(of: "</think>") { content = String(content[r.upperBound...]) }
            return Completion(text: content, error: nil, seconds: secs)
        } catch {
            return Completion(text: nil, error: String(describing: error), seconds: Date().timeIntervalSince(start))
        }
    }

    func complete(system: String, user: String) async -> Completion {
        await chat(system: system, user: user, json: false)
    }

    func diagnose(system: String, user: String) async -> (Diagnosis?, Completion) {
        let prompt = user + "\n\nAnswer with a JSON object with keys \"line\" (integer), \"cause\" (string) and \"fixedLine\" (string)."
        let c = await chat(system: system, user: prompt, json: true)
        guard let text = c.text,
              let start = text.firstIndex(of: "{"), let end = text.lastIndex(of: "}"),
              let data = String(text[start...end]).data(using: .utf8),
              let d = try? JSONDecoder().decode(Diagnosis.self, from: data)
        else { return (nil, c) }
        return (d, c)
    }
}
