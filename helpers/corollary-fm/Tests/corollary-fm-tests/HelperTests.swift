import Foundation
import Testing
@testable import corollary_fm

@Test func parsesRequestWithBody() {
    let raw = Data("POST /v1/ocr HTTP/1.1\r\nHost: x\r\nContent-Length: 4\r\n\r\nabcd".utf8)
    let (r, req) = parseRequest(raw)
    #expect(r == .done(consumed: raw.count))
    #expect(req?.path == "/v1/ocr")
    #expect(req?.body == Data("abcd".utf8))
    #expect(parseRequest(raw.prefix(raw.count - 1)).0 == .incomplete)
    #expect(parseRequest(Data("GARBAGE\r\n\r\n".utf8)).0 == .invalid)
    #expect(parseRequest(Data("POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n".utf8)).0 == .invalid)
}

@Test func comparesTokens() {
    #expect(sameSecret("Bearer abc", "Bearer abc"))
    #expect(!sameSecret("Bearer abd", "Bearer abc"))
    #expect(!sameSecret("Bearer ab", "Bearer abc"))
    #expect(!sameSecret(nil, "Bearer abc"))
}

@Test func flattensMessages() {
    let one = flatten([ChatMessage(role: "system", content: "S"), ChatMessage(role: "user", content: "U")])
    #expect(one.instructions == "S" && one.prompt == "U")
    let many = flatten([ChatMessage(role: "user", content: "a"), ChatMessage(role: "assistant", content: "b"), ChatMessage(role: "user", content: "c")])
    #expect(many.prompt == "User: a\n\nAssistant: b\n\nUser: c")
}

@Test func cleansOCROutput() {
    #expect(cleanLatex("$$ x^2 $$") == "x^2")
    #expect(cleanLatex("\\[a+b\\]") == "a+b")
    #expect(cleanLatex("$a$ and $b$") == "$a$ and $b$")
    #expect(cleanLatex("\\frac{1}{2}") == "\\frac{1}{2}")
}
