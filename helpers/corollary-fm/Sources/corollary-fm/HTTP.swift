import Foundation
import Network

struct Request {
    var method: String
    var path: String
    var headers: [String: String]
    var body: Data

    func json() -> [String: Any]? {
        (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
    }
}

enum ParseResult: Equatable {
    case incomplete
    case invalid
    case done(consumed: Int)
}

let maxBodyBytes = 32 << 20

/// Parses one HTTP/1.1 request with an optional Content-Length body. No chunked uploads.
func parseRequest(_ buf: Data) -> (ParseResult, Request?) {
    guard let headerEnd = buf.range(of: Data("\r\n\r\n".utf8)) else {
        return (buf.count > 64 << 10 ? .invalid : .incomplete, nil)
    }
    guard let head = String(data: buf[buf.startIndex..<headerEnd.lowerBound], encoding: .utf8) else { return (.invalid, nil) }
    var lines = head.components(separatedBy: "\r\n")
    let parts = lines.removeFirst().split(separator: " ")
    guard parts.count == 3, parts[2].hasPrefix("HTTP/1.") else { return (.invalid, nil) }
    var headers: [String: String] = [:]
    for line in lines {
        guard let colon = line.firstIndex(of: ":") else { return (.invalid, nil) }
        headers[line[..<colon].lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
    }
    if headers["transfer-encoding"] != nil { return (.invalid, nil) }
    let length = Int(headers["content-length"] ?? "0") ?? -1
    guard length >= 0, length <= maxBodyBytes else { return (.invalid, nil) }
    let bodyStart = headerEnd.upperBound
    guard buf.endIndex - bodyStart >= length else { return (.incomplete, nil) }
    let body = buf[bodyStart..<bodyStart + length]
    let req = Request(method: String(parts[0]), path: String(parts[1]), headers: headers, body: Data(body))
    return (.done(consumed: bodyStart + length - buf.startIndex), req)
}

final class Response {
    private let conn: NWConnection
    private var started = false

    init(_ conn: NWConnection) { self.conn = conn }

    private static func reason(_ status: Int) -> String {
        switch status {
        case 200: "OK"
        case 400: "Bad Request"
        case 401: "Unauthorized"
        case 404: "Not Found"
        case 409: "Conflict"
        case 413: "Payload Too Large"
        case 503: "Service Unavailable"
        default: "Error"
        }
    }

    private func send(_ data: Data) async {
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            conn.send(content: data, completion: .contentProcessed { _ in c.resume() })
        }
    }

    func json(_ status: Int, _ obj: Any) async {
        let body = (try? JSONSerialization.data(withJSONObject: obj, options: [.withoutEscapingSlashes])) ?? Data()
        let head = "HTTP/1.1 \(status) \(Self.reason(status))\r\nContent-Type: application/json\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n"
        await send(Data(head.utf8) + body)
        conn.cancel()
    }

    func error(_ status: Int, _ message: String, code: String? = nil) async {
        var err: [String: Any] = ["message": message, "type": "corollary_fm_error"]
        if let code { err["code"] = code }
        await json(status, ["error": err])
    }

    /// Server-sent events; the connection closes when the stream ends.
    func event(_ obj: Any) async {
        if !started {
            started = true
            await send(Data("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n".utf8))
        }
        let data = (try? JSONSerialization.data(withJSONObject: obj, options: [.withoutEscapingSlashes])) ?? Data()
        await send(Data("data: ".utf8) + data + Data("\n\n".utf8))
    }

    func endEvents() async {
        await send(Data("data: [DONE]\n\n".utf8))
        conn.cancel()
    }
}

/// Only touched on the listener's serial queue.
private final class Flag: @unchecked Sendable {
    var value = false
}

/// Constant-time, so response timing can't reveal the token a byte at a time.
func sameSecret(_ given: String?, _ expected: String) -> Bool {
    guard let given else { return false }
    let a = Array(given.utf8), b = Array(expected.utf8)
    guard a.count == b.count else { return false }
    return zip(a, b).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) } == 0
}

typealias Handler = @Sendable (Request, Response) async -> Void

final class Server: @unchecked Sendable {
    private let listener: NWListener
    private let token: String?
    private let handler: Handler
    private let queue = DispatchQueue(label: "corollary-fm.http")

    init(port: UInt16, token: String?, handler: @escaping Handler) throws {
        let params = NWParameters.tcp
        // Loopback only: the helper must never be reachable from the network.
        params.requiredLocalEndpoint = NWEndpoint.hostPort(host: .ipv4(.loopback), port: NWEndpoint.Port(rawValue: port)!)
        params.allowLocalEndpointReuse = true
        listener = try NWListener(using: params)
        self.token = token
        self.handler = handler
    }

    func start() async throws -> UInt16 {
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<UInt16, Error>) in
            let resumed = Flag()
            listener.stateUpdateHandler = { [listener] state in
                guard !resumed.value else { return }
                switch state {
                case .ready:
                    resumed.value = true
                    c.resume(returning: listener.port?.rawValue ?? 0)
                case .failed(let e):
                    resumed.value = true
                    c.resume(throwing: e)
                default: break
                }
            }
            listener.newConnectionHandler = { [weak self] conn in self?.accept(conn) }
            listener.start(queue: queue)
        }
    }

    private func accept(_ conn: NWConnection) {
        conn.start(queue: queue)
        read(conn, Data())
    }

    private func read(_ conn: NWConnection, _ buf: Data) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            var buf = buf
            if let data { buf.append(data) }
            switch parseRequest(buf) {
            case (.done, let req?):
                let res = Response(conn)
                Task { await self.dispatch(req, res) }
            case (.incomplete, _) where error == nil && !isComplete:
                self.read(conn, buf)
            default:
                Task { await Response(conn).error(400, "malformed request") }
            }
        }
    }

    private func dispatch(_ req: Request, _ res: Response) async {
        // A browser page can reach loopback too; the token keeps it from using the model.
        if let token, !sameSecret(req.headers["authorization"], "Bearer \(token)") {
            await res.error(401, "missing or wrong token")
            return
        }
        await handler(req, res)
    }
}
