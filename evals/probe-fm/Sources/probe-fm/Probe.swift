import Foundation

// probe-fm: how well does Apple's on-device model edit LaTeX?
//
//   swift run -c release probe-fm                 # full run, Apple model only
//   swift run -c release probe-fm --quick         # 5 paragraphs, fast sanity check
//   swift run -c release probe-fm --ollama-model qwen3.5:9b [--ollama-url http://host:11434]
//   swift run -c release probe-fm --compile       # also compile edits with Tectonic
//   swift run -c release probe-fm --skip-apple --ollama-model ...   # baseline only

enum Action: String, CaseIterable, Codable {
    case rewrite, shorten, grammar, formalize

    var instruction: String {
        switch self {
        case .rewrite: return "Rewrite the following LaTeX paragraph to improve clarity and flow without changing its meaning."
        case .shorten: return "Shorten the following LaTeX paragraph by about 30% while keeping all technical content, citations and references."
        case .grammar: return "Fix grammar, spelling and punctuation errors in the following LaTeX paragraph. Change nothing else."
        case .formalize: return "Rewrite the following LaTeX paragraph in a formal academic register suitable for a peer-reviewed paper."
        }
    }
}

let editSystem = """
You are an editing assistant for scientific papers written in LaTeX. You receive a LaTeX excerpt and return ONLY the edited excerpt: no explanation, no introduction, no Markdown, no code fences. \
Rules: keep every LaTeX command, environment, math expression, citation key, reference key and label exactly as written. Do not add packages or new commands. Edit only the prose.
"""

let diagnoseSystem = "You are an expert in LaTeX who diagnoses compilation errors precisely."

struct EditRecord: Codable {
    var backend: String, mode: String, action: Action, id: String, field: String
    var seconds: Double, error: String?, output: String?, check: CheckResult?, compiles: Bool?
    var retried = false, inputTokens: Int?
}
struct DiagRecord: Codable {
    var backend: String, id: String, seconds: Double, error: String?
    var line: Int?, cause: String?, fixedLine: String?, lineCorrect: Bool, fixCorrect: Bool
}
struct GuardRecord: Codable {
    var backend: String, id: String, field: String, refused: Bool, error: String?, output: String?
}
struct ContextRecord: Codable { var paragraphs: Int, words: Int, tokens: Int?, ok: Bool, seconds: Double, error: String? }
struct Machine: Codable { var os: String, model: String, chip: String, memoryGB: Int }
/// One real generation from this plain command-line binary: the sidecar plumbing check.
struct SmokeRecord: Codable { var ok: Bool, seconds: Double, output: String?, error: String? }

struct Results: Codable {
    var startedAt: String
    var machine: Machine
    var appleAvailability: String
    var contextSize: Int?
    var smoke: SmokeRecord?
    var timeToFirstTokenPrewarmed: [Double] = []
    var edits: [EditRecord] = []
    var diagnoses: [DiagRecord] = []
    var guardrails: [GuardRecord] = []
    var context: [ContextRecord] = []
    var timeToFirstToken: [Double] = []
}

func sysctlString(_ name: String) -> String {
    var size = 0
    guard sysctlbyname(name, nil, &size, nil, 0) == 0, size > 0 else { return "?" }
    var buf = [CChar](repeating: 0, count: size)
    sysctlbyname(name, &buf, &size, nil, 0)
    return String(cString: buf)
}
func sysctlUInt64(_ name: String) -> UInt64 {
    var v: UInt64 = 0
    var size = MemoryLayout<UInt64>.size
    sysctlbyname(name, &v, &size, nil, 0)
    return v
}

func looksLikeRefusal(_ c: Completion) -> Bool {
    let e = (c.error ?? "").lowercased()
    if e.contains("guardrail") || e.contains("refus") || e.contains("unsafe") { return true }
    let t = (c.text ?? "").lowercased()
    return ["i can't", "i cannot", "i'm sorry", "i am sorry", "i'm unable", "i am unable"].contains { t.hasPrefix($0) }
}

func pct(_ a: Int, _ b: Int) -> String { b == 0 ? "–" : String(format: "%.0f%%", 100.0 * Double(a) / Double(b)) }
func mean(_ xs: [Double]) -> Double { xs.isEmpty ? 0 : xs.reduce(0, +) / Double(xs.count) }
func median(_ xs: [Double]) -> Double {
    guard !xs.isEmpty else { return 0 }
    let s = xs.sorted()
    return s.count % 2 == 1 ? s[s.count / 2] : (s[s.count / 2 - 1] + s[s.count / 2]) / 2
}

@main
struct Probe {
    static func main() async {
        let args = CommandLine.arguments
        func value(_ flag: String) -> String? {
            guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
            return args[i + 1]
        }
        let quick = args.contains("--quick")
        let skipApple = args.contains("--skip-apple")
        let wantCompile = args.contains("--compile")
        let ollamaModel = value("--ollama-model")
        let ollamaURL = value("--ollama-url") ?? "http://localhost:11434"

        let machine = Machine(
            os: ProcessInfo.processInfo.operatingSystemVersionString,
            model: sysctlString("hw.model"),
            chip: sysctlString("machdep.cpu.brand_string"),
            memoryGB: Int(sysctlUInt64("hw.memsize") / 1_073_741_824))
        let iso = ISO8601DateFormatter().string(from: Date())
        print("probe-fm  \(iso)")
        print("Machine: \(machine.chip), \(machine.memoryGB) GB, macOS \(machine.os)")

        let unavailable = AppleFM.availability()
        print("Apple on-device model: \(unavailable.map { "UNAVAILABLE (\($0))" } ?? "available")")
        var results = Results(startedAt: iso, machine: machine, appleAvailability: unavailable ?? "available")

        var backends: [Backend] = []
        if !skipApple {
            if unavailable == nil {
                results.contextSize = AppleFM.contextSize
                print("Context size reported by the API: \(AppleFM.contextSize) tokens")
                let c = await AppleFM().complete(system: "Reply with exactly one word.", user: "Say OK.")
                results.smoke = SmokeRecord(ok: c.text != nil, seconds: c.seconds, output: c.text, error: c.error)
                print("Generation from a plain command-line binary outside Xcode: "
                      + (c.text != nil ? String(format: "works (cold first call %.1fs)", c.seconds) : "FAILED: \(c.error ?? "")"))
                if c.text != nil { backends.append(AppleFM()) }
            }
            else { print("→ Skipping Apple tests. Check System Settings → Apple Intelligence & Siri (enabled, English (US), download finished).") }
        }
        if let m = ollamaModel { backends.append(OpenAICompatible(baseURL: ollamaURL, model: m)) }
        if backends.isEmpty { print("Nothing to test. Exiting."); return }

        let compile = wantCompile && Compiler.available()
        if wantCompile && !compile { print("→ --compile requested but tectonic not found (brew install tectonic). Skipping compile checks.") }

        let paragraphs = quick ? Array(Corpus.paragraphs.prefix(5)) : Corpus.paragraphs
        let errors = quick ? Array(Corpus.errors.prefix(3)) : Corpus.errors
        let sensitive = quick ? Array(Corpus.sensitive.prefix(2)) : Corpus.sensitive

        var originalCompiles: [String: Bool] = [:]
        if compile {
            print("\nCompiling originals with Tectonic (first run downloads packages)…")
            for p in paragraphs { originalCompiles[p.id] = Compiler.compiles(body: p.text) }
        }

        // 1. LaTeX-fidelity edits
        for backend in backends {
            print("\n== Edits: \(backend.name) ==")
            for action in Action.allCases {
                for p in paragraphs {
                    let user = action.instruction + "\n\n" + p.text
                    let inputTokens = backend is AppleFM ? await AppleFM.tokenCount(editSystem + "\n" + user) : nil
                    var modes: [(String, Completion)] = [("text", await backend.complete(system: editSystem, user: user))]
                    if let apple = backend as? AppleFM, action == .rewrite {
                        modes.append(("structured", await apple.completeStructured(system: editSystem, user: user)))
                    }
                    for (mode, c) in modes {
                        var rec = EditRecord(backend: backend.name, mode: mode, action: action, id: p.id, field: p.field,
                                             seconds: c.seconds, error: c.error, output: c.text, check: nil, compiles: nil,
                                             retried: c.retried, inputTokens: inputTokens)
                        if let text = c.text {
                            let chk = Latex.check(input: p.text, rawOutput: text, allowMathDrop: action == .shorten)
                            rec.check = chk
                            if compile, originalCompiles[p.id] == true {
                                rec.compiles = Compiler.compiles(body: Latex.clean(text).text)
                            }
                        }
                        results.edits.append(rec)
                        let mark = rec.check?.intact == true ? "✓" : (c.error != nil ? "ERR" : "✗")
                        let a = action.rawValue.padding(toLength: 10, withPad: " ", startingAt: 0)
                        let m = mode.padding(toLength: 11, withPad: " ", startingAt: 0)
                        print("  \(a)\(m)\(p.id)  \(mark)  \(String(format: "%.1fs", c.seconds))\(c.retried ? "  (retried)" : "")")
                    }
                }
            }
        }

        // 2. Compile-error diagnosis
        for backend in backends {
            print("\n== Error diagnosis: \(backend.name) ==")
            for e in errors {
                let numbered = e.source.enumerated().map { "\($0.offset + 1): \($0.element)" }.joined(separator: "\n")
                let user = "A LaTeX document failed to compile.\n\nSource (with line numbers):\n\(numbered)\n\nCompiler log:\n\(e.log)\n\nIdentify the line where the error originates, explain the cause, and give the corrected version of that line."
                let (d, c) = await backend.diagnose(system: diagnoseSystem, user: user)
                let lineOK = d.map { e.acceptableLines.contains($0.line) } ?? false
                let fixOK = d.map { $0.fixedLine.contains(e.fixMustContain) } ?? false
                results.diagnoses.append(DiagRecord(backend: backend.name, id: e.id, seconds: c.seconds, error: c.error,
                                                    line: d?.line, cause: d?.cause, fixedLine: d?.fixedLine,
                                                    lineCorrect: lineOK, fixCorrect: fixOK))
                print("  \(e.id): line \(lineOK ? "✓" : "✗")  fix \(fixOK ? "✓" : "✗")  \(String(format: "%.1fs", c.seconds))\(c.error.map { "  ERR \($0)" } ?? "")")
            }
        }

        // 3. False refusals on legitimate sensitive research
        var guardBackends = backends
        if backends.contains(where: { $0 is AppleFM }) { guardBackends.append(AppleFM(permissiveGuardrails: true)) }
        for backend in guardBackends {
            print("\n== Sensitive topics: \(backend.name) ==")
            for s in sensitive {
                let c = await backend.complete(system: editSystem, user: Action.rewrite.instruction + "\n\n" + s.text)
                let refused = looksLikeRefusal(c) || c.text == nil
                results.guardrails.append(GuardRecord(backend: backend.name, id: s.id, field: s.field, refused: refused, error: c.error, output: c.text))
                print("  \(s.id) \(s.field): \(refused ? "REFUSED/ERROR" : "ok")\(c.error.map { "  (\($0))" } ?? "")")
            }
        }

        // 4. Apple speed + context limit
        if let apple = backends.first(where: { $0 is AppleFM }) as? AppleFM {
            print("\n== Apple speed ==")
            for p in paragraphs.prefix(5) {
                let user = Action.rewrite.instruction + "\n\n" + p.text
                let cold = await apple.timeToFirstToken(system: editSystem, user: user, prewarm: false)
                let warm = await apple.timeToFirstToken(system: editSystem, user: user, prewarm: true)
                if let cold { results.timeToFirstToken.append(cold) }
                if let warm { results.timeToFirstTokenPrewarmed.append(warm) }
                func fmt(_ t: Double?) -> String { t.map { String(format: "%.2fs", $0) } ?? "–" }
                print("  time to first token (\(p.id)): new session \(fmt(cold)), prewarmed \(fmt(warm))")
            }
            if !quick {
                print("\n== Apple context limit (summarize N paragraphs) ==")
                let system = "Summarize the LaTeX excerpt in one sentence."
                for n in [1, 2, 4, 8, 12, 16, 24, 32] {
                    let text = (0..<n).map { Corpus.paragraphs[$0 % Corpus.paragraphs.count].text }.joined(separator: "\n\n")
                    let words = text.split(whereSeparator: { $0.isWhitespace }).count
                    let tokens = await AppleFM.tokenCount(system + "\n" + text)
                    let c = await apple.complete(system: system, user: text)
                    results.context.append(ContextRecord(paragraphs: n, words: words, tokens: tokens, ok: c.text != nil, seconds: c.seconds, error: c.error))
                    let t = tokens.map { "\($0) tokens" } ?? "? tokens"
                    print("  \(n) paragraphs (~\(words) words, \(t)): \(c.text != nil ? "ok" : "FAILED: \(c.error ?? "")")")
                    if c.text == nil { break }
                }
            }
        }

        // 5. Report
        let report = Report.markdown(results, quick: quick, compiled: compile)
        print("\n" + report)
        let dir = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("results")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let stamp = iso.replacingOccurrences(of: ":", with: "-")
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        try? enc.encode(results).write(to: dir.appendingPathComponent("probe-\(stamp).json"))
        try? report.write(to: dir.appendingPathComponent("probe-\(stamp).md"), atomically: true, encoding: .utf8)
        print("Saved results/probe-\(stamp).md and .json")
    }
}

enum Report {
    static func markdown(_ r: Results, quick: Bool, compiled: Bool) -> String {
        var md = "# Apple on-device model: LaTeX probe\n\n"
        md += "- Run: \(r.startedAt)\(quick ? " (quick mode)" : "")\n"
        md += "- Machine: \(r.machine.chip), \(r.machine.memoryGB) GB, \(r.machine.model), macOS \(r.machine.os)\n"
        md += "- Apple model availability: \(r.appleAvailability)\n"
        if let n = r.contextSize { md += "- Context size reported by the API: \(n) tokens\n" }
        if let s = r.smoke {
            md += "- Generation from a plain command-line binary outside Xcode: "
            md += s.ok ? String(format: "works (cold first call %.1fs)\n", s.seconds) : "FAILED (`\(s.error ?? "")`)\n"
        }
        md += "\n"

        md += "## Edits: share that kept LaTeX intact\n\n"
        md += "| Backend | Mode | Action | Intact | Keys kept | Math unaltered | Braces/$ ok | No chatter | Code fences | Errors | Retried | Median s |"
        md += (compiled ? " Compiles |" : "") + "\n"
        md += "|---|---|---|---|---|---|---|---|---|---|---|---|" + (compiled ? "---|" : "") + "\n"
        let groups = Dictionary(grouping: r.edits) { "\($0.backend)|\($0.mode)|\($0.action.rawValue)" }
        for key in groups.keys.sorted() {
            let recs = groups[key]!
            let checks = recs.compactMap { $0.check }
            let n = recs.count
            let parts = key.split(separator: "|").map(String.init)
            md += "| \(parts[0]) | \(parts[1]) | \(parts[2]) "
            md += "| \(pct(checks.filter { $0.intact }.count, n)) "
            md += "| \(pct(checks.filter { $0.keysPreserved }.count, n)) "
            md += "| \(pct(checks.filter { $0.mathUnaltered }.count, n)) "
            md += "| \(pct(checks.filter { $0.bracesBalanced && $0.dollarsBalanced }.count, n)) "
            md += "| \(pct(checks.filter { $0.noChatter }.count, n)) "
            md += "| \(pct(checks.filter { $0.hadCodeFence }.count, n)) "
            md += "| \(recs.filter { $0.error != nil }.count) "
            md += "| \(recs.filter { $0.retried }.count) "
            md += String(format: "| %.1f ", median(recs.map { $0.seconds }))
            if compiled {
                let c = recs.compactMap { $0.compiles }
                md += "| \(pct(c.filter { $0 }.count, c.count)) "
            }
            md += "|\n"
        }

        md += "\n## Decision gate (plain-text edits, all four actions)\n\n"
        for backend in Set(r.edits.map { $0.backend }).sorted() {
            let recs = r.edits.filter { $0.backend == backend && $0.mode == "text" }
            let ok = recs.filter { $0.check?.intact == true }.count
            let rate = recs.isEmpty ? 0 : Double(ok) / Double(recs.count)
            let verdict: String
            if !backend.hasPrefix("apple") { verdict = "(baseline)" }
            else if rate >= 0.9 { verdict = "GO: Apple model is the ⌘K default" }
            else if rate >= 0.6 { verdict = "GO WITH GUARDRAILS: validator + math/command masking; prose-only actions on Apple" }
            else { verdict = "PIVOT: Ollama/MLX is the ⌘K default; Apple model for captions/short explanations" }
            md += "- **\(backend)**: \(ok)/\(recs.count) intact (\(String(format: "%.0f%%", rate * 100))) → \(verdict)\n"
        }
        let structured = r.edits.filter { $0.mode == "structured" }
        if !structured.isEmpty {
            md += "- Apple structured (@Generable) rewrite: \(structured.filter { $0.check?.intact == true }.count)/\(structured.count) intact "
            md += "(reported for comparison only; not part of the gate, since the app sends edits as plain text)\n"
        }

        md += "\n## Compile-error diagnosis\n\n| Backend | Right line | Valid fix | Errors |\n|---|---|---|---|\n"
        for b in Set(r.diagnoses.map { $0.backend }).sorted() {
            let d = r.diagnoses.filter { $0.backend == b }
            md += "| \(b) | \(pct(d.filter { $0.lineCorrect }.count, d.count)) | \(pct(d.filter { $0.fixCorrect }.count, d.count)) | \(d.filter { $0.error != nil }.count) |\n"
        }

        md += "\n## Sensitive-but-legitimate research (false refusals)\n\n| Backend | Refused or errored |\n|---|---|\n"
        for b in Set(r.guardrails.map { $0.backend }).sorted() {
            let g = r.guardrails.filter { $0.backend == b }
            let names = g.filter { $0.refused }.map { $0.id }.joined(separator: ", ")
            md += "| \(b) | \(g.filter { $0.refused }.count)/\(g.count)\(names.isEmpty ? "" : " (\(names))") |\n"
        }

        if !r.timeToFirstToken.isEmpty {
            md += String(format: "\n## Speed\n\n- Apple time to first token, new session: median %.2fs\n", median(r.timeToFirstToken))
            if !r.timeToFirstTokenPrewarmed.isEmpty {
                md += String(format: "- Apple time to first token, prewarmed session: median %.2fs\n", median(r.timeToFirstTokenPrewarmed))
            }
            let apple = r.edits.filter { $0.backend == "apple-fm" && $0.mode == "text" }.map { $0.seconds }
            if !apple.isEmpty { md += String(format: "- Apple full paragraph edit: median %.1fs, mean %.1fs\n", median(apple), mean(apple)) }
        }
        if !r.context.isEmpty {
            md += "\n## Context limit\n\n"
            let okMax = r.context.filter { $0.ok }.map { $0.words }.max() ?? 0
            let okTokens = r.context.filter { $0.ok }.compactMap { $0.tokens }.max()
            md += "- Largest input that worked: ~\(okMax) words\(okTokens.map { " (\($0) tokens by `tokenCount`)" } ?? "")\n"
            if let fail = r.context.first(where: { !$0.ok }) {
                md += "- First failure at ~\(fail.words) words\(fail.tokens.map { " (\($0) tokens)" } ?? ""): `\(fail.error ?? "")`\n"
                if let t = fail.tokens, let n = r.contextSize {
                    md += "- `tokenCount` \(t > n ? "predicted" : "did not predict") this failure before sending\n"
                }
            }
        }

        let failures = r.edits.filter { $0.check != nil && $0.check?.intact == false }.prefix(12)
        if !failures.isEmpty {
            md += "\n## Sample failures\n\n"
            for f in failures {
                guard let c = f.check else { continue }
                var why: [String] = []
                if !c.missingKeys.isEmpty { why.append("dropped keys \(c.missingKeys)") }
                if !c.addedKeys.isEmpty { why.append("invented keys \(c.addedKeys)") }
                if !c.alteredMath.isEmpty { why.append("changed math \(c.alteredMath.prefix(2))") }
                if !c.mathPreserved && f.action != .shorten { why.append("dropped math") }
                if !c.bracesBalanced { why.append("unbalanced braces") }
                if !c.dollarsBalanced { why.append("unbalanced $") }
                if !c.newCommands.isEmpty { why.append("new commands \(c.newCommands)") }
                if !c.noChatter { why.append("chatty preface") }
                if !c.noMarkdown { why.append("markdown") }
                md += "- \(f.backend) / \(f.mode) / \(f.action.rawValue) / \(f.id): \(why.joined(separator: "; "))\n"
            }
        }
        md += "\nFull outputs are in the matching .json file.\n"
        return md
    }
}
