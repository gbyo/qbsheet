import Foundation

/// The identity of one running Live Activity: one shard of one publication, opened for one team.
///
/// Activity attributes are immutable, so this key is the whole compatibility story: two states
/// with equal keys can share an activity (update it), and two with different keys cannot (the
/// old one must be ended and a new one requested). The broadcast channel follows the shard, so
/// a key change is also a channel change.
public struct LiveActivityKey: Equatable, Hashable, Sendable {
    public let publicationId: String
    public let shard: Int
    public let slot: Int
    public let followedTeamId: String

    public init(publicationId: String, shard: Int, slot: Int, followedTeamId: String) {
        self.publicationId = publicationId
        self.shard = shard
        self.slot = slot
        self.followedTeamId = followedTeamId
    }

    public init(attributes: QBLiveActivityAttributes) {
        self.init(
            publicationId: attributes.publicationId,
            shard: attributes.shard,
            slot: attributes.slot,
            followedTeamId: attributes.followedTeamId
        )
    }

    /// The key the given follow state wants, or nil when there is nothing to show: no snapshot,
    /// no followed team, or a team that is not in this snapshot.
    public init?(snapshot: QBLiveSnapshot, followedTeamId: String) {
        guard let attributes = QBLiveSharding.attributes(for: followedTeamId, in: snapshot) else {
            return nil
        }
        self.init(attributes: attributes)
    }
}

/// What the lifecycle driver needs from whoever talks to ActivityKit.
///
/// A protocol rather than the concrete coordinator so the decision logic in
/// `LiveActivityDriver` can be tested without ActivityKit's static APIs. The full app's
/// `LiveActivityCoordinator` conforms; the App Clip never supplies one.
@MainActor
public protocol LiveActivityControlling {
    /// Keys of the activities the system is currently running.
    func existingKeys() async -> [LiveActivityKey]
    func start(snapshot: QBLiveSnapshot, followedTeamId: String) async
    func update(snapshot: QBLiveSnapshot, followedTeamId: String) async
    func end(publicationId: String) async
}

/// Decides when to start, update, or end the team Live Activity.
///
/// One driver per view hierarchy, fed by snapshot/followed-team changes. The rules:
///
/// - Same key as last time: `update`, never a second `start`. Repeated view appearances and
///   foreground revision ticks converge here, which is what keeps one publication on one activity.
/// - Different key, same publication (a team or shard change): `start`. Ending the incompatible
///   same-publication activity before requesting the replacement happens inside `start`, next to
///   the ActivityKit calls it needs, so every `start` caller gets it.
/// - Different publication: `end` the old one, then `start`.
/// - No key (no snapshot, no followed team, unknown team): `end` the stale publication once.
/// - Fresh driver with a compatible activity already running (app relaunch): adopt it with an
///   `update` instead of requesting a duplicate.
///
/// The driver deliberately does not check `capabilities.applePush` itself. It always reconciles
/// through the controller so the coordinator records `notEnabledForTournament` and its spectator
/// explanation; skipping the call would leave `availability` at `.unknown`, which is the dead
/// lifecycle path this exists to fix.
@MainActor
public final class LiveActivityDriver {
    private var lastKey: LiveActivityKey?
    private var lastPublicationId: String?
    private var endedPublicationId: String?

    public init() {}

    public func reconcile(
        snapshot: QBLiveSnapshot?,
        followedTeamId: String?,
        controller: any LiveActivityControlling
    ) async {
        guard let snapshot,
              let followedTeamId,
              let desired = LiveActivityKey(snapshot: snapshot, followedTeamId: followedTeamId)
        else {
            await endStale(snapshot: snapshot, controller: controller)
            return
        }
        if desired == lastKey {
            await controller.update(snapshot: snapshot, followedTeamId: followedTeamId)
            return
        }
        if lastKey == nil, await controller.existingKeys().contains(desired) {
            // Relaunch: the system kept the activity across the restart, so adopt it with an
            // update rather than requesting a second one.
            await controller.update(snapshot: snapshot, followedTeamId: followedTeamId)
        } else {
            if let previous = lastPublicationId, previous != desired.publicationId {
                await controller.end(publicationId: previous)
            }
            await controller.start(snapshot: snapshot, followedTeamId: followedTeamId)
        }
        lastKey = desired
        lastPublicationId = desired.publicationId
        endedPublicationId = nil
    }

    /// No followable state: make sure a stale activity is ended, exactly once per publication.
    private func endStale(snapshot: QBLiveSnapshot?, controller: any LiveActivityControlling) async {
        // Prefer the publication we started: after a relaunch that memory is gone, and the
        // loaded snapshot names the publication whose system activity would otherwise linger.
        let stale = lastPublicationId ?? snapshot?.publicationId
        if let stale, stale != endedPublicationId {
            await controller.end(publicationId: stale)
            endedPublicationId = stale
        }
        lastKey = nil
        lastPublicationId = nil
    }
}
