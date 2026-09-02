import Foundation

/// A QBLive client built on `URLSession`.
///
/// No third-party networking, both because the App Clip has a size budget and because there is
/// nothing here a dependency would do better: four GETs and a WebSocket.
///
/// Every response is size-capped before it is decoded. A QBLive backend is somebody else's server,
/// and a phone that streamed an unbounded body into memory would be a crash a tournament director
/// could cause by accident.
public actor QBLiveClient {
    public enum Failure: Error, LocalizedError, Equatable {
        case network(String)
        case http(status: Int, code: String, message: String, currentRevision: Int?)
        case tooLarge
        case malformed(String)
        case unsupportedProtocol(Int)

        public var errorDescription: String? {
            switch self {
            case .network(let detail): detail
            case .http(_, _, let message, _): message
            case .tooLarge: "That tournament document is too large."
            case .malformed(let detail): "The tournament server sent something unexpected. \(detail)"
            case .unsupportedProtocol(let version):
                "This tournament needs a newer version of QBSheet Live (protocol \(version))."
            }
        }

        /// Whether retrying could ever help. A deleted tournament is not a connectivity problem.
        public var isPermanent: Bool {
            if case .http(let status, _, _, _) = self { return status == 404 || status == 410 }
            if case .unsupportedProtocol = self { return true }
            return false
        }
    }

    /// 8 MB. A 512-team tournament with full player statistics is far under this.
    public static let maximumBodyBytes = 8 * 1024 * 1024

    private let bootstrap: QBLiveBootstrap
    private let session: URLSession

    public init(bootstrap: QBLiveBootstrap, session: URLSession? = nil) {
        self.bootstrap = bootstrap
        if let session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.timeoutIntervalForRequest = 15
            configuration.timeoutIntervalForResource = 30
            // Public tournament data. Nothing here is credentialed, and a cookie jar shared with a
            // tournament's own backend is a surface with no use.
            configuration.httpShouldSetCookies = false
            configuration.httpCookieAcceptPolicy = .never
            configuration.waitsForConnectivity = false
            self.session = URLSession(configuration: configuration)
        }
    }

    public nonisolated var publicationId: String { bootstrap.publicationId }

    public func manifest() async throws -> QBLiveManifest {
        let manifest: QBLiveManifest = try await get(bootstrap.endpoint("manifest"))
        guard manifest.protocolVersion == QBLive.protocolVersion else {
            throw Failure.unsupportedProtocol(manifest.protocolVersion)
        }
        return manifest
    }

    public func snapshot() async throws -> QBLiveSnapshot {
        let snapshot: QBLiveSnapshot = try await get(bootstrap.endpoint("snapshot"))
        guard snapshot.protocolVersion == QBLive.protocolVersion else {
            throw Failure.unsupportedProtocol(snapshot.protocolVersion)
        }
        return snapshot
    }

    public func events(after revision: Int, limit: Int = 64) async throws -> QBLiveEventPage {
        var components = URLComponents(url: bootstrap.endpoint("events"), resolvingAgainstBaseURL: false)
        components?.queryItems = [
            URLQueryItem(name: "after", value: String(revision)),
            URLQueryItem(name: "limit", value: String(limit)),
        ]
        guard let url = components?.url else { throw Failure.malformed("Could not build the events URL.") }
        return try await get(url)
    }

    private func get<T: Decodable>(_ url: URL) async throws -> T {
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "accept")

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch let error as URLError {
            throw Failure.network(friendly(error))
        } catch {
            throw Failure.network("The tournament server could not be reached.")
        }

        guard data.count <= Self.maximumBodyBytes else { throw Failure.tooLarge }
        guard let http = response as? HTTPURLResponse else {
            throw Failure.malformed("The response was not HTTP.")
        }
        guard (200..<300).contains(http.statusCode) else {
            let body = try? QBLiveCoding.decoder.decode(QBLiveErrorBody.self, from: data)
            throw Failure.http(
                status: http.statusCode,
                code: body?.error ?? "internal",
                message: body?.message ?? "The tournament server answered \(http.statusCode).",
                currentRevision: body?.currentRevision
            )
        }
        do {
            return try QBLiveCoding.decoder.decode(T.self, from: data)
        } catch {
            throw Failure.malformed(String(describing: error))
        }
    }

    /// A sentence a spectator can act on, rather than an NSError description.
    private func friendly(_ error: URLError) -> String {
        switch error.code {
        case .notConnectedToInternet, .networkConnectionLost:
            "This device is not connected to the internet."
        case .timedOut:
            "The tournament server did not respond in time."
        case .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed:
            "The tournament server could not be found."
        case .appTransportSecurityRequiresSecureConnection, .secureConnectionFailed:
            "The tournament server's connection is not secure."
        default:
            "The tournament server could not be reached."
        }
    }
}
