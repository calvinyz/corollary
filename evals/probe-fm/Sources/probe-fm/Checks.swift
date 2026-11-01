import Foundation

/// Automatic checks that an edit kept the LaTeX intact.
struct CheckResult: Codable {
    var nonEmpty = true
    var noChatter = true          // no "Here is the revised paragraph:" preface
    var hadCodeFence = false      // informational: fences are stripped before checking
    var noMarkdown = true         // no **bold** or other markdown leaking in
    var keysPreserved = true      // same set of cite/ref/label keys
    var mathUnaltered = true      // every math segment in the output existed in the input
    var mathPreserved = true      // every math segment in the input survives
    var bracesBalanced = true
    var dollarsBalanced = true
    var noNewCommands = true      // no invented \commands
    var missingKeys: [String] = []
    var addedKeys: [String] = []
    var alteredMath: [String] = []
    var newCommands: [String] = []
    var lengthRatio = 1.0
    var intact = true
}

enum Latex {
    static func matches(_ pattern: String, in s: String) -> [[String]] {
        guard let re = try? NSRegularExpression(pattern: pattern) else { return [] }
        let ns = s as NSString
        return re.matches(in: s, range: NSRange(location: 0, length: ns.length)).map { m in
            (0..<m.numberOfRanges).map { i in
                let r = m.range(at: i)
                return r.location == NSNotFound ? "" : ns.substring(with: r)
            }
        }
    }

    /// cite/ref/label keys as "family:key". \cref vs \Cref vs \ref are one family.
    static func keys(_ s: String) -> Set<String> {
        let pattern = #"\\(cite[a-zA-Z]*|[cC]ref|ref|eqref|autoref|pageref|label)\*?(?:\[[^\]]*\])*\{([^}]*)\}"#
        var out = Set<String>()
        for m in matches(pattern, in: s) {
            let cmd = m[1]
            let family = cmd.hasPrefix("cite") ? "cite" : (cmd == "label" ? "label" : "ref")
            for k in m[2].split(separator: ",") {
                out.insert("\(family):\(k.trimmingCharacters(in: .whitespaces))")
            }
        }
        return out
    }

    static func normalize(_ s: String) -> String {
        s.components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty }.joined(separator: " ")
    }

    /// Display and inline math segments, whitespace-normalized.
    static func mathSegments(_ s: String) -> [String] {
        var t = s.replacingOccurrences(of: #"\$"#, with: "<ESCAPED-DOLLAR>")
        var segs: [String] = []
        let patterns = [
            #"\\begin\{(equation|align|gather|multline|eqnarray)(\*?)\}[\s\S]*?\\end\{\1\2\}"#,
            #"\$\$[\s\S]*?\$\$"#,
            #"\\\[[\s\S]*?\\\]"#,
            #"\\\([\s\S]*?\\\)"#,
            #"\$[^$]+\$"#,
        ]
        for p in patterns {
            guard let re = try? NSRegularExpression(pattern: p) else { continue }
            let ns = t as NSString
            let range = NSRange(location: 0, length: ns.length)
            for m in re.matches(in: t, range: range) { segs.append(normalize(ns.substring(with: m.range))) }
            t = re.stringByReplacingMatches(in: t, range: range, withTemplate: " ")
        }
        return segs
    }

    static func commands(_ s: String) -> Set<String> {
        Set(matches(#"\\([a-zA-Z]+)"#, in: s).map { $0[1] })
    }

    /// Unescaped { } balance and unescaped $ parity.
    static func balance(_ s: String) -> (braces: Bool, dollars: Bool) {
        var depth = 0, dollars = 0, escaped = false, ok = true
        for ch in s {
            if escaped { escaped = false; continue }
            switch ch {
            case "\\": escaped = true
            case "{": depth += 1
            case "}": depth -= 1; if depth < 0 { ok = false }
            case "$": dollars += 1
            default: break
            }
        }
        return (ok && depth == 0, dollars % 2 == 0)
    }

    /// Strip Markdown code fences a model may wrap around its answer.
    static func clean(_ raw: String) -> (text: String, hadFence: Bool) {
        var lines = raw.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: "\n")
        var fence = false
        if let first = lines.first, first.hasPrefix("```") { lines.removeFirst(); fence = true }
        if let last = lines.last, last.hasPrefix("```") { lines.removeLast(); fence = true }
        return (lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines), fence)
    }

    static let allowedNewCommands: Set<String> = [
        "emph", "textit", "textbf", "ldots", "dots", "eg", "ie", "textemdash", "textendash", "S",
    ]

    static func check(input: String, rawOutput: String, allowMathDrop: Bool) -> CheckResult {
        var r = CheckResult()
        let (out, fence) = clean(rawOutput)
        r.hadCodeFence = fence
        r.nonEmpty = !out.isEmpty

        let firstLine = out.components(separatedBy: "\n").first?.lowercased() ?? ""
        let chatterStarts = ["here is", "here's", "sure", "certainly", "below is", "the revised", "the edited",
                             "the rewritten", "revised paragraph", "edited paragraph", "i can't", "i cannot", "i'm sorry"]
        r.noChatter = !chatterStarts.contains { firstLine.hasPrefix($0) }
        r.noMarkdown = !out.contains("**")

        let kin = keys(input), kout = keys(out)
        r.missingKeys = Array(kin.subtracting(kout)).sorted()
        r.addedKeys = Array(kout.subtracting(kin)).sorted()
        r.keysPreserved = r.missingKeys.isEmpty && r.addedKeys.isEmpty

        let mIn = Set(mathSegments(input)), mout = Set(mathSegments(out))
        r.alteredMath = Array(mout.subtracting(mIn)).sorted()
        r.mathUnaltered = r.alteredMath.isEmpty
        r.mathPreserved = mIn.isSubset(of: mout)

        let b = balance(out)
        r.bracesBalanced = b.braces
        r.dollarsBalanced = b.dollars

        r.newCommands = Array(commands(out).subtracting(commands(input)).subtracting(allowedNewCommands)).sorted()
        r.noNewCommands = r.newCommands.isEmpty

        r.lengthRatio = input.isEmpty ? 1 : Double(out.count) / Double(input.count)

        r.intact = r.nonEmpty && r.noChatter && r.noMarkdown && r.keysPreserved && r.mathUnaltered
            && (allowMathDrop || r.mathPreserved) && r.bracesBalanced && r.dollarsBalanced && r.noNewCommands
        return r
    }
}

/// Optional: compile original vs edited text with Tectonic.
enum Compiler {
    static func available() -> Bool { run(["tectonic", "--version"], in: nil).ok }

    static func compiles(body: String) -> Bool {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("probe-fm-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let doc = Corpus.preamble + "\n" + body + "\n\\end{document}\n"
        let file = dir.appendingPathComponent("t.tex")
        guard (try? doc.write(to: file, atomically: true, encoding: .utf8)) != nil else { return false }
        return run(["tectonic", "--chatter", "minimal", file.path], in: dir).ok
    }

    @discardableResult
    static func run(_ args: [String], in dir: URL?) -> (ok: Bool, output: String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        p.arguments = args
        if let dir { p.currentDirectoryURL = dir }
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:" + (env["PATH"] ?? "/usr/bin:/bin")
        p.environment = env
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        do { try p.run() } catch { return (false, "\(error)") }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return (p.terminationStatus == 0, String(decoding: data, as: UTF8.self))
    }
}
