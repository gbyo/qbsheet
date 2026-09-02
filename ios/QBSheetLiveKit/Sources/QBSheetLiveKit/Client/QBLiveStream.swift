import Foundation

/// The QBLive WebSocket, as an `AsyncStream` of decoded frames.
///
/// `URLSessionWebSocketTask` rather than a library: it is in the SDK, it handles the upgrade, and
/// the App Clip does not pay for it.
///
/// Frames whose `type` this build does not recognise are dropped silently. That is a protocol
/// requirement rather than laziness — a future server has to be able to add one without breaking
/// installed clients.
public enum QBLiveFrame: Sendable {
    case hello(revision: Int)
    case event(QBLiveEvent)
    case resync(currentRevision: Int)
    case final(revision: Int)
}

public actor QBLiveStream {
    private let url: URL
    private let session: URLSession
    private var task: URLSessionWebSocketTask?

    public init(url: URL, session: URLSession = .shared) {
        self.url = url
        self.session = session
    }

    /// Open the socket and yield frames until it closes or the consumer cancels.
    ///
    /// The stream finishes rather than throwing on a closed socket: a dropped WebSocket during a
    /// tournament is ordinary, and the caller's response is to fall back to polling and retry, not
    /// to surface an error to a spectator.
    public func frames() -> AsyncStream<QBLiveFrame> {
        AsyncStream { continuation in
            let task = session.webSocketTask(with: url)
            self.task = task
            task.resume()

            /// Receive recursively. `receive` delivers one message; re-arming inside the completion
            /// is the documented way to keep reading, and it keeps the socket off the actor.
            @Sendable func receive() {
                task.receive { result in
                    switch result {
                    case .failure:
                        continuation.finish()
                    case .success(let message):
                        let data: Data? =
                            switch message {
                            case .data(let payload): payload
                            case .string(let text): text.data(using: .utf8)
                            @unknown default: nil
                            }
                        if let data, let frame = Self.decode(data) {
                            continuation.yield(frame)
                        }
                        receive()
                    }
                }
            }
            receive()

            continuation.onTermination = { _ in
                task.cancel(with: .goingAway, reason: nil)
            }
        }
    }

    public func close() {
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
    }

    static func decode(_ data: Data) -> QBLiveFrame? {
        struct Envelope: Decodable {
            let type: String
            let revision: Int?
            let currentRevision: Int?
            let event: QBLiveEvent?
        }
        guard let envelope = try? QBLiveCoding.decoder.decode(Envelope.self, from: data) else { return nil }
        switch envelope.type {
        case "hello": return .hello(revision: envelope.revision ?? 0)
        case "event": return envelope.event.map(QBLiveFrame.event)
        case "resync": return .resync(currentRevision: envelope.currentRevision ?? 0)
        case "final": return .final(revision: envelope.revision ?? 0)
        default: return nil
        }
    }
}
