import Foundation
import FoundationModels

struct ChatMessage {
    var role: String
    var content: String

    /// OpenAI `messages`, with content as a string or an array of text parts.
    static func parse(_ raw: Any?) -> [ChatMessage]? {
        guard let arr = raw as? [[String: Any]], !arr.isEmpty else { return nil }
        return arr.compactMap { m in
            guard let role = m["role"] as? String else { return nil }
            if let s = m["content"] as? String { return ChatMessage(role: role, content: s) }
            let parts = (m["content"] as? [[String: Any]] ?? []).compactMap { $0["text"] as? String }
            return ChatMessage(role: role, content: parts.joined(separator: "\n"))
        }
    }
}

/// Splits messages into instructions and a single prompt; earlier turns become a transcript.
func flatten(_ messages: [ChatMessage]) -> (instructions: String, prompt: String) {
    let instructions = messages.filter { $0.role == "system" || $0.role == "developer" }.map(\.content).joined(separator: "\n\n")
    let turns = messages.filter { $0.role != "system" && $0.role != "developer" }
    if turns.count == 1 { return (instructions, turns[0].content) }
    let prompt = turns.map { "\($0.role == "assistant" ? "Assistant" : "User"): \($0.content)" }.joined(separator: "\n\n")
    return (instructions, prompt)
}

struct HelperError: Error {
    var status: Int
    var code: String
    var message: String
}

enum AppleModel {
    static let defaultContext = 4096
    /// A 1,024-token cap stops runaway generations, which ran for minutes without one.
    static let maxOutput = 1024
    /// `tokenCount` undercounts by about 80 tokens of framework overhead.
    static let overhead = 128

    static func status() -> [String: Any] {
        guard #available(macOS 26, *) else {
            return ["available": false, "reason": "requiresMacOS26"]
        }
        var s: [String: Any] = ["contextSize": contextSize]
        switch SystemLanguageModel.default.availability {
        case .available:
            s["available"] = true
        case .unavailable(let reason):
            s["available"] = false
            s["reason"] = String(describing: reason)
        }
        return s
    }

    static var contextSize: Int {
        if #available(macOS 26.4, *) { return SystemLanguageModel.default.contextSize }
        return defaultContext
    }

    @available(macOS 26, *)
    static func tokens(_ text: String) async -> Int {
        if #available(macOS 26.4, *), let n = try? await SystemLanguageModel.default.tokenCount(for: text) { return n }
        // Rough fallback: about 3.5 characters per token for English LaTeX.
        return text.utf8.count * 2 / 7 + 1
    }

    /// Drops the oldest turns until the prompt fits; a single oversized prompt is an error.
    @available(macOS 26, *)
    static func fit(_ messages: [ChatMessage], maxOutput: Int) async throws -> (String, String) {
        var messages = messages
        let budget = contextSize - maxOutput - overhead
        while true {
            let (instructions, prompt) = flatten(messages)
            let used = await tokens(instructions) + tokens(prompt)
            if used <= budget { return (instructions, prompt) }
            let turns = messages.indices.filter { messages[$0].role != "system" && messages[$0].role != "developer" }
            guard turns.count > 1 else {
                throw HelperError(status: 400, code: "context_length_exceeded",
                                  message: "The text is too long for the on-device model (\(used) of \(budget) tokens). Select less text or use a larger model.")
            }
            messages.remove(at: turns[0])
        }
    }

    @available(macOS 26, *)
    private static func helperError(_ error: Error) -> HelperError {
        if let e = error as? LanguageModelSession.GenerationError {
            switch e {
            case .guardrailViolation:
                return HelperError(status: 400, code: "guardrail", message: "Apple's on-device model declined this text (safety guardrail).")
            case .exceededContextWindowSize:
                return HelperError(status: 400, code: "context_length_exceeded", message: "The text is too long for the on-device model.")
            case .unsupportedLanguageOrLocale:
                return HelperError(status: 400, code: "unsupported_language", message: "Apple's on-device model doesn't support this language.")
            case .assetsUnavailable:
                return HelperError(status: 503, code: "model_unavailable", message: "Apple's on-device model isn't ready yet. Check Apple Intelligence in System Settings.")
            case .rateLimited:
                return HelperError(status: 503, code: "rate_limited", message: "Apple's on-device model is busy; try again in a moment.")
            default: break
            }
        }
        return HelperError(status: 500, code: "generation_failed", message: String(describing: error))
    }

    /// The framework occasionally fails with an unexplained `LanguageModelError -1`; that's retried once.
    private static func isTransient(_ error: Error) -> Bool {
        let ns = error as NSError
        return ns.domain.hasPrefix("FoundationModels") && ns.code == -1
    }

    /// Streams deltas through `onDelta` and returns the full text.
    @available(macOS 26, *)
    static func complete(messages: [ChatMessage], maxTokens: Int?, temperature: Double?, onDelta: (String) async -> Void) async throws -> String {
        if case .unavailable(let reason) = SystemLanguageModel.default.availability {
            throw HelperError(status: 503, code: "model_unavailable", message: "Apple's on-device model is unavailable: \(reason)")
        }
        let maxOut = min(maxTokens ?? maxOutput, maxOutput)
        let (instructions, prompt) = try await fit(messages, maxOutput: maxOut)
        let options = GenerationOptions(temperature: temperature ?? 0.2, maximumResponseTokens: maxOut)
        var retried = false
        while true {
            let session = LanguageModelSession(model: .default, instructions: instructions)
            var sent = ""
            do {
                for try await snapshot in session.streamResponse(to: prompt, options: options) {
                    let full = snapshot.content
                    // Snapshots are cumulative; forward only the new suffix.
                    if full.hasPrefix(sent) {
                        let delta = String(full.dropFirst(sent.count))
                        if !delta.isEmpty { await onDelta(delta) }
                        sent = full
                    }
                }
                return sent
            } catch {
                if !retried && sent.isEmpty && isTransient(error) { retried = true; continue }
                throw helperError(error)
            }
        }
    }
}
