import Foundation

/// Reads the Happy agent daemon over its private Unix socket.
///
/// The daemon mints its bearer token on first start, so the token file may still be missing when
/// the menu bar comes up; the token is therefore read for every connection rather than once.
final class DaemonClient {
    private let socketPath: String
    private let tokenPath: String

    init(socketPath: String, tokenPath: String) {
        self.socketPath = socketPath
        self.tokenPath = tokenPath
    }

    /// One `GET` returning the parsed JSON body, or `nil` when the daemon is not answering yet.
    func get(_ path: String) -> Any? {
        guard let token = try? String(contentsOfFile: tokenPath, encoding: .utf8) else {
            return nil
        }
        guard let socket = try? DaemonSocket(path: socketPath, timeout: 15) else { return nil }
        let request = """
            GET \(path) HTTP/1.1\r
            Host: happy-agent\r
            Authorization: Bearer \(token.trimmingCharacters(in: .whitespacesAndNewlines))\r
            Accept: application/json\r
            Connection: close\r
            \r

            """
        guard (try? socket.write(request)) != nil else { return nil }
        guard let head = try? readHead(socket), head.status == 200 else { return nil }
        guard let body = try? readBody(socket, head: head) else { return nil }
        return try? JSONSerialization.jsonObject(with: body)
    }

    /// Follows the daemon's event stream, reporting the type of every event until it ends.
    ///
    /// The menu bar only needs to know that something changed, so the payloads are skipped and
    /// the caller re-reads the snapshots it cares about.
    func streamEventTypes(_ onEvent: (String) -> Void) {
        guard let token = try? String(contentsOfFile: tokenPath, encoding: .utf8) else { return }
        guard let socket = try? DaemonSocket(path: socketPath, timeout: 120) else { return }
        let request = """
            GET /v0/events/stream HTTP/1.1\r
            Host: happy-agent\r
            Authorization: Bearer \(token.trimmingCharacters(in: .whitespacesAndNewlines))\r
            Accept: text/event-stream\r
            \r

            """
        guard (try? socket.write(request)) != nil else { return }
        guard let head = try? readHead(socket), head.status == 200 else { return }
        let lines = head.chunked ? chunkedLines(socket) : plainLines(socket)
        for line in lines where line.hasPrefix("event:") {
            onEvent(String(line.dropFirst("event:".count)).trimmingCharacters(in: .whitespaces))
        }
    }

    private struct ResponseHead {
        let status: Int
        let contentLength: Int?
        let chunked: Bool
    }

    private func readHead(_ socket: DaemonSocket) throws -> ResponseHead {
        guard let statusLine = try socket.readLine() else { throw DaemonSocketError.closed }
        let statusFields = statusLine.split(separator: " ")
        guard statusFields.count >= 2, let status = Int(statusFields[1]) else {
            throw DaemonSocketError.malformed
        }
        var contentLength: Int?
        var chunked = false
        while let line = try socket.readLine(), !line.isEmpty {
            let parts = line.split(separator: ":", maxSplits: 1)
            guard parts.count == 2 else { continue }
            let name = parts[0].lowercased()
            let value = parts[1].trimmingCharacters(in: .whitespaces).lowercased()
            if name == "content-length" { contentLength = Int(value) }
            if name == "transfer-encoding" { chunked = value.contains("chunked") }
        }
        return ResponseHead(status: status, contentLength: contentLength, chunked: chunked)
    }

    private func readBody(_ socket: DaemonSocket, head: ResponseHead) throws -> Data {
        if let length = head.contentLength { return try socket.read(count: length) }
        if head.chunked {
            var body = Data()
            while let sizeLine = try socket.readLine() {
                let size = Int(sizeLine.split(separator: ";")[0], radix: 16) ?? 0
                if size == 0 { break }
                body.append(try socket.read(count: size))
                _ = try socket.readLine()
            }
            return body
        }
        return try socket.readToEnd()
    }

    /// Chunk framing unwrapped into the lines the stream inside it is made of.
    private func chunkedLines(_ socket: DaemonSocket) -> AnySequence<String> {
        AnySequence { () -> AnyIterator<String> in
            var pending = Data()
            var finished = false
            return AnyIterator {
                while true {
                    if let index = pending.firstIndex(of: 0x0A) {
                        let line = pending[pending.startIndex..<index]
                        pending.removeSubrange(pending.startIndex...index)
                        let trimmed = line.last == 0x0D ? line.dropLast() : line
                        return String(decoding: trimmed, as: UTF8.self)
                    }
                    if finished { return nil }
                    guard let sizeLine = try? socket.readLine(),
                        let header = sizeLine.split(separator: ";").first,
                        let size = Int(header, radix: 16)
                    else {
                        return nil
                    }
                    if size == 0 {
                        finished = true
                        continue
                    }
                    guard let chunk = try? socket.read(count: size) else { return nil }
                    pending.append(chunk)
                    _ = try? socket.readLine()
                }
            }
        }
    }

    private func plainLines(_ socket: DaemonSocket) -> AnySequence<String> {
        AnySequence { () -> AnyIterator<String> in
            AnyIterator { try? socket.readLine() }
        }
    }
}
