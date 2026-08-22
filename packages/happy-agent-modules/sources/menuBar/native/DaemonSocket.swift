import Foundation

enum DaemonSocketError: Error {
    case unavailable
    case closed
    case malformed
}

/// A blocking, buffered connection to the daemon's Unix socket.
///
/// The daemon speaks HTTP/1.1 over a private socket file, so the whole transport is a stream of
/// bytes this type hands out as lines or fixed-length blocks. Every instance is used from one
/// background thread at a time.
final class DaemonSocket {
    private let descriptor: Int32
    private var buffer = Data()
    private var atEnd = false

    init(path: String, timeout: TimeInterval) throws {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw DaemonSocketError.unavailable }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: address.sun_path) else {
            close(fd)
            throw DaemonSocketError.unavailable
        }
        withUnsafeMutableBytes(of: &address.sun_path) { destination in
            destination.copyBytes(from: bytes)
        }
        let connected = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { generic in
                connect(fd, generic, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard connected == 0 else {
            close(fd)
            throw DaemonSocketError.unavailable
        }
        var limit = timeval(
            tv_sec: Int(timeout),
            tv_usec: suseconds_t((timeout - timeout.rounded(.down)) * 1_000_000)
        )
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &limit, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &limit, socklen_t(MemoryLayout<timeval>.size))
        descriptor = fd
    }

    deinit {
        close(descriptor)
    }

    func write(_ text: String) throws {
        var remaining = Array(text.utf8)[...]
        while !remaining.isEmpty {
            let written = remaining.withUnsafeBytes { bytes in
                send(descriptor, bytes.baseAddress, bytes.count, 0)
            }
            guard written > 0 else { throw DaemonSocketError.closed }
            remaining = remaining.dropFirst(written)
        }
    }

    /// One CRLF-terminated line without its terminator, or `nil` once the peer stops sending.
    func readLine() throws -> String? {
        while true {
            if let index = buffer.firstIndex(of: 0x0A) {
                let line = buffer[buffer.startIndex..<index]
                buffer.removeSubrange(buffer.startIndex...index)
                let trimmed = line.last == 0x0D ? line.dropLast() : line
                return String(decoding: trimmed, as: UTF8.self)
            }
            if atEnd {
                if buffer.isEmpty { return nil }
                let rest = String(decoding: buffer, as: UTF8.self)
                buffer.removeAll()
                return rest
            }
            try fill()
        }
    }

    func read(count: Int) throws -> Data {
        while buffer.count < count {
            if atEnd { throw DaemonSocketError.closed }
            try fill()
        }
        let block = buffer.prefix(count)
        buffer.removeFirst(count)
        return Data(block)
    }

    /// Everything the peer sends before it closes, for responses that carry no length at all.
    func readToEnd() throws -> Data {
        while !atEnd {
            try fill()
        }
        let rest = buffer
        buffer.removeAll()
        return rest
    }

    private func fill() throws {
        var chunk = [UInt8](repeating: 0, count: 16 * 1024)
        let count = chunk.withUnsafeMutableBytes { bytes in
            recv(descriptor, bytes.baseAddress, bytes.count, 0)
        }
        if count > 0 {
            buffer.append(contentsOf: chunk[0..<count])
            return
        }
        if count == 0 {
            atEnd = true
            return
        }
        throw DaemonSocketError.closed
    }
}
