import Foundation
import Observation
import QBSheetLiveKit
#if canImport(ActivityKit)
import ActivityKit
#endif

/// Starting, updating and ending the team Live Activity.
///
/// # Broadcast channels, not per-device tokens
///
/// QBSheet Live requires iOS 18, so remote updates use ActivityKit broadcast push channels
/// exclusively. `pushType: .channel(id)` subscribes this Activity to a channel the push gateway
/// created for the team's shard; every viewer of that shard shares the channel, so the number of
/// APNs channels a tournament consumes scales with shards, not with people.
///
/// # Graceful degradation
///
/// Everything here can fail: the user can refuse Live Activities, the push gateway can be
/// unreachable, and Apple's global channel budget can be exhausted. None of that is allowed to
/// break QBSheet Live. The app, the App Clip, the web client, foreground realtime, schedules,
/// standings, statistics and results all keep working; only the Lock Screen surface is lost, and
/// `unavailableReason` says which of those happened.
@MainActor
@Observable
public final class LiveActivityCoordinator {
    public enum Availability: Equatable, Sendable {
        case unknown
        case available
        /// The user has Live Activities switched off for this app or the device.
        case notPermitted
        /// The tournament has not enabled Apple background updates.
        case notEnabledForTournament
        /// The push gateway could not give us a channel. Foreground updates still work.
        case channelUnavailable(String)
    }

    public private(set) var availability: Availability = .unknown
    public private(set) var isRunning = false

    private let persistence: LivePersistence
    private let gateway: PushGatewayClient

    public init(persistence: LivePersistence = .shared, gateway: PushGatewayClient = PushGatewayClient()) {
        self.persistence = persistence
        self.gateway = gateway
    }

    /// The sentence Director's own status panel uses, adapted for a spectator.
    public var explanation: String? {
        switch availability {
        case .unknown, .available: nil
        case .notPermitted:
            "Turn on Live Activities for QBSheet Live in Settings to see this tournament on your Lock Screen."
        case .notEnabledForTournament:
            "This tournament has not turned on Lock Screen updates."
        case .channelUnavailable:
            "Lock Screen updates are temporarily unavailable. Everything else is working."
        }
    }

    public func start(snapshot: QBLiveSnapshot, followedTeamId: String) async {
        #if canImport(ActivityKit)
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            availability = .notPermitted
            return
        }
        guard snapshot.capabilities.applePush else {
            availability = .notEnabledForTournament
            return
        }
        guard let attributes = QBLiveSharding.attributes(for: followedTeamId, in: snapshot) else { return }

        // Ask the gateway for this shard's channel. Lazily created there: a channel exists only
        // once somebody actually wants an Activity in that shard, which is what keeps a 64-team
        // tournament from consuming eight of Apple's ten thousand channels for nothing.
        let channelId: String
        do {
            channelId = try await gateway.channel(
                publicationId: snapshot.publicationId,
                shard: attributes.shard
            )
        } catch {
            availability = .channelUnavailable(error.localizedDescription)
            return
        }

        let initial = QBLiveActivityState.contentState(shard: attributes.shard, in: snapshot)
        do {
            _ = try Activity.request(
                attributes: attributes,
                content: .init(state: initial, staleDate: staleDate(from: snapshot)),
                pushType: .channel(channelId)
            )
            persistence.activityChannelId = channelId
            availability = .available
            isRunning = true
        } catch {
            availability = .channelUnavailable(error.localizedDescription)
        }
        #else
        availability = .notPermitted
        #endif
    }

    /// Refresh the running Activity from a foreground snapshot.
    ///
    /// The socket is faster and cheaper than a push, so while the app is in front the Activity is
    /// updated locally and the push path stays idle.
    public func update(snapshot: QBLiveSnapshot, followedTeamId: String) async {
        #if canImport(ActivityKit)
        guard let attributes = QBLiveSharding.attributes(for: followedTeamId, in: snapshot) else { return }
        let state = QBLiveActivityState.contentState(shard: attributes.shard, in: snapshot)
        for activity in Activity<QBLiveActivityAttributes>.activities
        where activity.attributes.publicationId == snapshot.publicationId {
            await activity.update(.init(state: state, staleDate: staleDate(from: snapshot)))
        }
        #endif
    }

    public func end(publicationId: String) async {
        #if canImport(ActivityKit)
        for activity in Activity<QBLiveActivityAttributes>.activities
        where activity.attributes.publicationId == publicationId {
            await activity.end(nil, dismissalPolicy: .default)
        }
        isRunning = false
        persistence.activityChannelId = nil
        #endif
    }

    /// When the Lock Screen should stop presenting this state as current.
    ///
    /// Twelve minutes: long enough to survive a round with no scoring updates, short enough that a
    /// tournament whose backend went down does not leave a stale score looking live all afternoon.
    /// ActivityKit dims the Activity past this point rather than removing it, which is the honest
    /// presentation of "we do not know any more".
    private func staleDate(from snapshot: QBLiveSnapshot) -> Date? {
        snapshot.final ? nil : Date().addingTimeInterval(12 * 60)
    }
}

/// The client for `push.qbsheet.com`.
///
/// Deliberately tiny. It asks for a channel id and registers a notification token; it never sends
/// tournament data, because the gateway is not the Live backend and must not become a second
/// tournament database. See `docs/QBLIVE.md#13-apple-push`.
public struct PushGatewayClient: Sendable {
    public enum Failure: Error, LocalizedError {
        case unavailable
        case refused(String)

        public var errorDescription: String? {
            switch self {
            case .unavailable: "The QBSheet push service could not be reached."
            case .refused(let message): message
            }
        }
    }

    public static let defaultOrigin = URL(string: "https://push.qbsheet.com")!

    private let origin: URL
    private let session: URLSession

    public init(origin: URL = PushGatewayClient.defaultOrigin, session: URLSession = .shared) {
        self.origin = origin
        self.session = session
    }

    /// Ask for the broadcast channel serving a shard, creating it if this is the first request.
    public func channel(publicationId: String, shard: Int) async throws -> String {
        struct Body: Encodable {
            let publicationId: String
            let shard: Int
        }
        struct Reply: Decodable {
            let channelId: String
        }
        var request = URLRequest(url: origin.appendingPathComponent("v1/activity/channel"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(Body(publicationId: publicationId, shard: shard))
        request.timeoutInterval = 10

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw Failure.unavailable }
        guard http.statusCode == 200 else {
            let message = (try? JSONDecoder().decode([String: String].self, from: data))?["message"]
            throw Failure.refused(message ?? "Lock Screen updates are unavailable for this tournament.")
        }
        return try JSONDecoder().decode(Reply.self, from: data).channelId
    }

    /// Register this device for ordinary announcement notifications.
    ///
    /// A per-device token, unlike the Activity's channel. Announcements are low-frequency, so
    /// per-device fanout is affordable and gives the gateway the audience routing it needs.
    public func registerForAnnouncements(
        publicationId: String,
        deviceToken: Data,
        followedTeamId: String?,
        isAppClip: Bool
    ) async throws {
        struct Body: Encodable {
            let publicationId: String
            let deviceToken: String
            let followedTeamId: String?
            let clientKind: String
        }
        var request = URLRequest(url: origin.appendingPathComponent("v1/notifications/register"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(
            Body(
                publicationId: publicationId,
                deviceToken: deviceToken.map { String(format: "%02x", $0) }.joined(),
                followedTeamId: followedTeamId,
                // The gateway needs this: an App Clip's notifications are ephemeral and are routed
                // to a different APNs topic than the full app's.
                clientKind: isAppClip ? "app-clip" : "app"
            )
        )
        request.timeoutInterval = 10
        let (_, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 204 || http.statusCode == 200 else {
            throw Failure.unavailable
        }
    }
}
