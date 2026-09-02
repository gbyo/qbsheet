import Foundation
import Testing
@testable import QBSheetLiveKit

/// The bootstrap parser is the first thing an attacker reaches, because it parses a URL printed on
/// a poster. These tests are mostly about what it refuses, and they mirror
/// `packages/qblive-protocol/tests/bootstrap.test.ts` case for case.
struct QBLiveBootstrapTests {
    static let publicationId = "bcdfghjkmnpqrstvwxyz"

    @Test("round trips the documented shape")
    func roundTrip() throws {
        let url = try #require(
            URL(string: "https://live.qbsheet.com/t/\(Self.publicationId)?b=https%3A%2F%2Fqblive.example.workers.dev&v=1")
        )
        let bootstrap = try QBLiveBootstrap(url: url)
        #expect(bootstrap.publicationId == Self.publicationId)
        #expect(bootstrap.backendOrigin.absoluteString == "https://qblive.example.workers.dev")
        #expect(bootstrap.version == 1)
        #expect(bootstrap.url().absoluteString.contains(Self.publicationId))
    }

    @Test("builds the QBLive routes")
    func routes() throws {
        let bootstrap = QBLiveBootstrap(
            publicationId: Self.publicationId,
            backendOrigin: try #require(URL(string: "https://x.example"))
        )
        #expect(
            bootstrap.endpoint("snapshot").absoluteString
                == "https://x.example/qblive/v1/tournaments/\(Self.publicationId)/snapshot"
        )
        #expect(
            bootstrap.streamURL(capabilities: QBLiveCapabilities(stream: true))?.scheme == "wss"
        )
        #expect(bootstrap.streamURL(capabilities: QBLiveCapabilities(stream: false)) == nil)
    }

    @Test(
        "refuses a hostile backend",
        arguments: [
            "javascript:alert(1)",
            "data:text/html,<script>",
            "file:///etc/passwd",
            "http://evil.example.com",
            "https://user:secret@backend.example",
            "https://backend.example/tenant/1",
            "https://backend.example?token=abc",
            "https://backend.example#fragment",
            "not a url at all",
            "",
        ]
    )
    func refusesHostileBackend(_ value: String) {
        #expect(throws: (any Error).self) { try QBLiveBootstrap.validateBackendOrigin(value) }
    }

    @Test("accepts HTTPS with a port")
    func httpsWithPort() throws {
        let url = try QBLiveBootstrap.validateBackendOrigin("https://backend.example:8443")
        #expect(url.absoluteString == "https://backend.example:8443")
    }

    @Test(
        "accepts plain HTTP only on the private ranges",
        arguments: ["http://192.168.1.20:8790", "http://10.0.0.5:8790", "http://127.0.0.1:8790", "http://localhost:8790"]
    )
    func lanMode(_ value: String) throws {
        #expect(throws: Never.self) { try QBLiveBootstrap.validateBackendOrigin(value) }
    }

    @Test("does not accept a public address over plain HTTP")
    func publicHttpRefused() {
        #expect(throws: (any Error).self) { try QBLiveBootstrap.validateBackendOrigin("http://8.8.8.8") }
    }

    @Test("the private-range check does not accept lookalikes")
    func privateRangeEdges() {
        #expect(!QBLiveBootstrap.isPrivateHost("172.15.0.1"))
        #expect(QBLiveBootstrap.isPrivateHost("172.16.0.1"))
        #expect(!QBLiveBootstrap.isPrivateHost("172.32.0.1"))
        #expect(!QBLiveBootstrap.isPrivateHost("192.168.999.1"))
        #expect(!QBLiveBootstrap.isPrivateHost("10.1.2.3.evil.example"))
    }

    @Test("a link with no backend is refused")
    func noBackend() throws {
        let url = try #require(URL(string: "https://live.qbsheet.com/t/\(Self.publicationId)"))
        #expect(throws: QBLiveBootstrap.ParseError.noBackend) { try QBLiveBootstrap(url: url) }
    }

    @Test("a future bootstrap version asks for a newer client rather than guessing")
    func futureVersion() throws {
        let url = try #require(
            URL(string: "https://live.qbsheet.com/t/\(Self.publicationId)?b=https%3A%2F%2Fx.example&v=99")
        )
        #expect(throws: QBLiveBootstrap.ParseError.futureVersion) { try QBLiveBootstrap(url: url) }
    }

    @Test("a self-hosted Live Web host parses the same way")
    func selfHostedHost() throws {
        let url = try #require(
            URL(string: "https://live.myleague.example/t/\(Self.publicationId)?b=https%3A%2F%2Fx.example&v=1")
        )
        #expect(try QBLiveBootstrap(url: url).publicationId == Self.publicationId)
    }

    @Test("a credential smuggled into the backend parameter is refused")
    func credentialSmuggling() throws {
        let encoded = "https%3A%2F%2Ftok%3Aen%40x.example"
        let url = try #require(URL(string: "https://live.qbsheet.com/t/\(Self.publicationId)?b=\(encoded)&v=1"))
        #expect(throws: QBLiveBootstrap.ParseError.credentialInBackend) { try QBLiveBootstrap(url: url) }
    }

    @Test("a publication id that is not one is refused")
    func badPublicationId() throws {
        for id in ["short", "AAAAAAAAAAAAAAAAAAAA", "aeiouaeiouaeiouaeiou", String(repeating: "b", count: 21)] {
            let url = try #require(URL(string: "https://live.qbsheet.com/t/\(id)?b=https%3A%2F%2Fx.example&v=1"))
            #expect(throws: (any Error).self) { try QBLiveBootstrap(url: url) }
        }
    }
}
