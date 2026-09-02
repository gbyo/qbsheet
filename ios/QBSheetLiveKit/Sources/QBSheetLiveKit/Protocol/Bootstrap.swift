import Foundation

/// The QBSheet Live bootstrap URL — the only thing in a printed QR code.
///
/// ```
/// https://live.qbsheet.com/t/<publicationId>?b=<backend origin>&v=1
/// ```
///
/// Parsed here rather than by whichever entry point received it, because there are four of them —
/// a universal link into the full app, an App Clip invocation, a notification tap, and a saved
/// bootstrap restored at launch — and four parsers would be four chances to accept something the
/// others reject.
///
/// The validation mirrors `packages/qblive-protocol/src/bootstrap.ts` exactly; the two have a shared
/// test corpus in `QBLiveBootstrapTests`.
public struct QBLiveBootstrap: Hashable, Sendable, Codable {
    public let version: Int
    public let publicationId: String
    /// The tournament backend's origin. Validated, no trailing slash.
    public let backendOrigin: URL

    public static let currentVersion = 1
    public static let officialHost = "live.qbsheet.com"

    public enum ParseError: Error, LocalizedError, Equatable {
        case notALink
        case noTournament
        case badPublicationId
        case noBackend
        case futureVersion
        case insecureBackend
        case credentialInBackend
        case backendHasPath
        case tooLong

        public var errorDescription: String? {
            switch self {
            case .notALink: "That is not a QBSheet Live link."
            case .noTournament: "That QBSheet Live link does not name a tournament."
            case .badPublicationId: "That QBSheet Live link does not name a valid tournament."
            case .noBackend: "That QBSheet Live link does not name a tournament server."
            case .futureVersion: "That QBSheet Live link needs a newer version of QBSheet Live."
            case .insecureBackend: "A QBSheet Live tournament server must use HTTPS."
            case .credentialInBackend: "That QBSheet Live link is not safe to open."
            case .backendHasPath: "That QBSheet Live link names an invalid tournament server."
            case .tooLong: "That QBSheet Live link is too long."
            }
        }
    }

    /// A generous ceiling that still fits a scannable printed QR code.
    static let maximumLinkLength = 512
    static let maximumOriginLength = 255

    private static let publicationAlphabet = Set("0123456789bcdfghjkmnpqrstvwxyz")

    public static func isPublicationId(_ value: String) -> Bool {
        value.count == 20 && value.allSatisfy { publicationAlphabet.contains($0) }
    }

    public init(version: Int = QBLiveBootstrap.currentVersion, publicationId: String, backendOrigin: URL) {
        self.version = version
        self.publicationId = publicationId
        self.backendOrigin = backendOrigin
    }

    public init(url: URL) throws {
        let raw = url.absoluteString
        guard raw.count <= Self.maximumLinkLength else { throw ParseError.tooLong }
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let scheme = components.scheme?.lowercased(),
              scheme == "https" || scheme == "http"
        else { throw ParseError.notALink }

        let path = components.percentEncodedPath
        let parts = path.split(separator: "/", omittingEmptySubsequences: true)
        guard parts.count == 2, parts[0] == "t" else { throw ParseError.noTournament }
        let publicationId = String(parts[1]).removingPercentEncoding ?? String(parts[1])
        guard Self.isPublicationId(publicationId) else { throw ParseError.badPublicationId }

        let items = components.queryItems ?? []
        let rawVersion = items.first { $0.name == "v" }?.value
        let version = rawVersion.flatMap(Int.init) ?? Self.currentVersion
        guard version >= 1 else { throw ParseError.notALink }
        guard version <= Self.currentVersion else { throw ParseError.futureVersion }

        guard let backend = items.first(where: { $0.name == "b" })?.value, !backend.isEmpty else {
            throw ParseError.noBackend
        }
        self.init(
            version: version,
            publicationId: publicationId,
            backendOrigin: try Self.validateBackendOrigin(backend)
        )
    }

    /// Validate a backend origin hard enough to hand to `URLSession`.
    ///
    /// Each rule answers a specific way a printed QR code could be hostile. Embedded userinfo is
    /// refused because a credential must never travel in a bootstrap URL, and accepting one would
    /// quietly turn a photographed code into a bearer token. A path is refused because the QBLive
    /// routes are appended to this origin and a base path could redirect them. Plain HTTP is
    /// allowed only on the private ranges, which is what Director's local-only LAN mode is.
    public static func validateBackendOrigin(_ raw: String) throws -> URL {
        guard raw.count <= maximumOriginLength else { throw ParseError.tooLong }
        guard let components = URLComponents(string: raw), let host = components.host, !host.isEmpty else {
            throw ParseError.noBackend
        }
        guard components.user == nil, components.password == nil else { throw ParseError.credentialInBackend }
        guard components.query == nil, components.fragment == nil else { throw ParseError.backendHasPath }
        guard components.path.isEmpty || components.path == "/" else { throw ParseError.backendHasPath }

        let scheme = components.scheme?.lowercased()
        if scheme == "https" {
            // Rebuild rather than reuse, so nothing but scheme, host and port survives.
            var clean = URLComponents()
            clean.scheme = "https"
            clean.host = host
            clean.port = components.port
            guard let url = clean.url else { throw ParseError.noBackend }
            return url
        }
        if scheme == "http", isPrivateHost(host) {
            var clean = URLComponents()
            clean.scheme = "http"
            clean.host = host
            clean.port = components.port
            guard let url = clean.url else { throw ParseError.noBackend }
            return url
        }
        throw ParseError.insecureBackend
    }

    /// Loopback and the private ranges. Deliberately narrow: everything else must be HTTPS.
    static func isPrivateHost(_ hostname: String) -> Bool {
        let host = hostname.trimmingCharacters(in: CharacterSet(charactersIn: "[]")).lowercased()
        if host == "localhost" || host == "::1" || host.hasSuffix(".local") { return true }
        let octets = host.split(separator: ".", omittingEmptySubsequences: false).map { Int($0) }
        guard octets.count == 4, octets.allSatisfy({ ($0 ?? -1) >= 0 && ($0 ?? 256) <= 255 }) else { return false }
        let values = octets.compactMap { $0 }
        guard values.count == 4 else { return false }
        switch (values[0], values[1]) {
        case (127, _), (10, _): return true
        case (192, 168): return true
        case (169, 254): return true
        case (172, 16...31): return true
        default: return false
        }
    }

    /// The public URL a Director prints, rebuilt from the parts.
    public func url(officialHost: String = QBLiveBootstrap.officialHost) -> URL {
        var components = URLComponents()
        components.scheme = "https"
        components.host = officialHost
        components.path = "/t/\(publicationId)"
        components.queryItems = [
            URLQueryItem(name: "b", value: backendOrigin.absoluteString),
            URLQueryItem(name: "v", value: String(version)),
        ]
        // The components above are all valid by construction; the fallback keeps this non-optional
        // for callers rather than pushing an impossible failure into every call site.
        return components.url ?? URL(string: "https://\(officialHost)/t/\(publicationId)")!
    }

    /// The QBLive route for a public document.
    public func endpoint(_ path: String) -> URL {
        backendOrigin
            .appendingPathComponent("qblive")
            .appendingPathComponent("v1")
            .appendingPathComponent("tournaments")
            .appendingPathComponent(publicationId)
            .appendingPathComponent(path)
    }

    /// The WebSocket URL, or nil when the backend does not advertise a stream.
    public func streamURL(capabilities: QBLiveCapabilities) -> URL? {
        guard capabilities.stream else { return nil }
        var components = URLComponents(url: endpoint("stream"), resolvingAgainstBaseURL: false)
        components?.scheme = backendOrigin.scheme == "https" ? "wss" : "ws"
        return components?.url
    }
}
