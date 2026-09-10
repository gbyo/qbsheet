import Foundation
import SwiftUI
import Testing
@testable import QBSheetLiveKit

/// The start/update/end decisions, without ActivityKit.
///
/// `LiveActivityDriver` talks to a `LiveActivityControlling` fake here; the real coordinator's
/// ActivityKit calls (including its `applePush` gate and graceful degradation) cannot run in a
/// test host. What these tests pin is the lifecycle wiring issue #741 is about: exactly one
/// activity per publication/shard, updates rather than duplicates, rebinding on shard or
/// publication changes, ending on unfollow, adopting a relaunched activity, and a nil controller
/// by default so the App Clip never drives one.
@MainActor
final class FakeLiveActivityController: LiveActivityControlling {
    /// What `existingKeys()` reports: the activities the system supposedly kept running.
    var existing: [LiveActivityKey] = []
    private(set) var starts: [(snapshot: QBLiveSnapshot, followedTeamId: String)] = []
    private(set) var updates: [(snapshot: QBLiveSnapshot, followedTeamId: String)] = []
    private(set) var ends: [String] = []

    func existingKeys() async -> [LiveActivityKey] { existing }

    func start(snapshot: QBLiveSnapshot, followedTeamId: String) async {
        starts.append((snapshot, followedTeamId))
    }

    func update(snapshot: QBLiveSnapshot, followedTeamId: String) async {
        updates.append((snapshot, followedTeamId))
    }

    func end(publicationId: String) async {
        ends.append(publicationId)
    }
}

struct LiveActivityDriverTests {
    func snapshot() throws -> QBLiveSnapshot {
        try QBLiveCoding.decoder.decode(
            QBLiveSnapshot.self,
            from: try QBLiveFixtureTests.fixture("snapshot-maximal")
        )
    }

    func withPublicationId(_ snapshot: QBLiveSnapshot, _ publicationId: String) -> QBLiveSnapshot {
        QBLiveSnapshot(
            protocolVersion: snapshot.protocolVersion,
            publicationId: publicationId,
            revision: snapshot.revision,
            generatedAt: snapshot.generatedAt,
            capabilities: snapshot.capabilities,
            final: snapshot.final,
            tournament: snapshot.tournament,
            teams: snapshot.teams,
            rooms: snapshot.rooms,
            timeline: snapshot.timeline,
            schedule: snapshot.schedule,
            results: snapshot.results,
            liveGames: snapshot.liveGames,
            standings: snapshot.standings,
            statistics: snapshot.statistics,
            announcements: snapshot.announcements
        )
    }

    func withRevision(_ snapshot: QBLiveSnapshot, _ revision: Int) -> QBLiveSnapshot {
        QBLiveSnapshot(
            protocolVersion: snapshot.protocolVersion,
            publicationId: snapshot.publicationId,
            revision: revision,
            generatedAt: snapshot.generatedAt,
            capabilities: snapshot.capabilities,
            final: snapshot.final,
            tournament: snapshot.tournament,
            teams: snapshot.teams,
            rooms: snapshot.rooms,
            timeline: snapshot.timeline,
            schedule: snapshot.schedule,
            results: snapshot.results,
            liveGames: snapshot.liveGames,
            standings: snapshot.standings,
            statistics: snapshot.statistics,
            announcements: snapshot.announcements
        )
    }

    func withTeams(_ snapshot: QBLiveSnapshot, _ teams: [QBLiveTeam]) -> QBLiveSnapshot {
        QBLiveSnapshot(
            protocolVersion: snapshot.protocolVersion,
            publicationId: snapshot.publicationId,
            revision: snapshot.revision,
            generatedAt: snapshot.generatedAt,
            capabilities: snapshot.capabilities,
            final: snapshot.final,
            tournament: snapshot.tournament,
            teams: teams,
            rooms: snapshot.rooms,
            timeline: snapshot.timeline,
            schedule: snapshot.schedule,
            results: snapshot.results,
            liveGames: snapshot.liveGames,
            standings: snapshot.standings,
            statistics: snapshot.statistics,
            announcements: snapshot.announcements
        )
    }

    @Test("a followed team triggers exactly one start")
    @MainActor
    func startsOnce() async throws {
        let driver = LiveActivityDriver()
        let controller = FakeLiveActivityController()
        let snapshot = try snapshot()
        await driver.reconcile(snapshot: snapshot, followedTeamId: "team-c", controller: controller)
        #expect(controller.starts.count == 1)
        #expect(controller.updates.isEmpty)
        #expect(controller.ends.isEmpty)
    }

    @Test("a new foreground revision updates the existing activity instead of duplicating it")
    @MainActor
    func revisionUpdates() async throws {
        let driver = LiveActivityDriver()
        let controller = FakeLiveActivityController()
        let snapshot = try snapshot()
        await driver.reconcile(snapshot: snapshot, followedTeamId: "team-c", controller: controller)
        await driver.reconcile(
            snapshot: withRevision(snapshot, snapshot.revision + 1),
            followedTeamId: "team-c",
            controller: controller
        )
        await driver.reconcile(
            snapshot: withRevision(snapshot, snapshot.revision + 2),
            followedTeamId: "team-c",
            controller: controller
        )
        #expect(controller.starts.count == 1)
        #expect(controller.updates.count == 2)
        #expect(controller.ends.isEmpty)
    }

    @Test("nothing starts without a followed team, and following later still works")
    @MainActor
    func noTeamNoStart() async throws {
        let driver = LiveActivityDriver()
        let controller = FakeLiveActivityController()
        let snapshot = try snapshot()
        await driver.reconcile(snapshot: snapshot, followedTeamId: nil, controller: controller)
        await driver.reconcile(snapshot: nil, followedTeamId: nil, controller: controller)
        #expect(controller.starts.isEmpty)
        #expect(controller.updates.isEmpty)
        // One sweep for an activity the system may have kept across a relaunch, then silence.
        #expect(controller.ends == [snapshot.publicationId])
        await driver.reconcile(snapshot: snapshot, followedTeamId: "team-c", controller: controller)
        #expect(controller.starts.count == 1)
    }

    @Test("a tournament without push support still reconciles exactly once, leaving the graceful gate to the coordinator")
    @MainActor
    func noPushSupportReconcilesOnce() async throws {
        // The fixture advertises applePush = false. The driver must still call through once so
        // the coordinator records notEnabledForTournament and its explanation; the coordinator,
        // not the driver, owns the gate that prevents Activity.request.
        let driver = LiveActivityDriver()
        let controller = FakeLiveActivityController()
        let snapshot = try snapshot()
        #expect(snapshot.capabilities.applePush == false)
        await driver.reconcile(snapshot: snapshot, followedTeamId: "team-c", controller: controller)
        await driver.reconcile(
            snapshot: withRevision(snapshot, snapshot.revision + 1),
            followedTeamId: "team-c",
            controller: controller
        )
        #expect(controller.starts.count == 1)
        #expect(controller.updates.count == 1)
        #expect(controller.ends.isEmpty)
    }

    @Test("changing team re-starts without ending the same publication, so the coordinator can rebind the channel")
    @MainActor
    func teamChangeRestarts() async throws {
        let driver = LiveActivityDriver()
        let controller = FakeLiveActivityController()
        let snapshot = try snapshot()
        await driver.reconcile(snapshot: snapshot, followedTeamId: "team-c", controller: controller)
        await driver.reconcile(snapshot: snapshot, followedTeamId: "team-a", controller: controller)
        #expect(controller.starts.count == 2)
        #expect(controller.starts.last?.followedTeamId == "team-a")
        // Same publication: ending the incompatible activity and requesting the replacement is
        // one atomic rebind inside start, not an end plus a start.
        #expect(controller.ends.isEmpty)
    }

    @Test("reordering teams into a new shard re-starts exactly once")
    @MainActor
    func shardChangeRestarts() async throws {
        let driver = LiveActivityDriver()
        let controller = FakeLiveActivityController()
        let snapshot = try snapshot()
        let reordered = withTeams(snapshot, snapshot.teams.reversed())
        #expect(LiveActivityKey(snapshot: snapshot, followedTeamId: "team-c") != LiveActivityKey(snapshot: reordered, followedTeamId: "team-c"))
        await driver.reconcile(snapshot: snapshot, followedTeamId: "team-c", controller: controller)
        await driver.reconcile(snapshot: reordered, followedTeamId: "team-c", controller: controller)
        #expect(controller.starts.count == 2)
        #expect(controller.updates.isEmpty)
        #expect(controller.ends.isEmpty)
    }

    @Test("switching publications ends the old one before starting the new one")
    @MainActor
    func publicationSwitchEndsOld() async throws {
        let driver = LiveActivityDriver()
        let controller = FakeLiveActivityController()
        let first = try snapshot()
        let second = withPublicationId(first, "another-publication")
        await driver.reconcile(snapshot: first, followedTeamId: "team-c", controller: controller)
        await driver.reconcile(snapshot: second, followedTeamId: "team-c", controller: controller)
        #expect(controller.ends == [first.publicationId])
        #expect(controller.starts.count == 2)
    }

    @Test("unfollowing ends the activity exactly once, and refollowing starts again")
    @MainActor
    func unfollowEndsOnce() async throws {
        let driver = LiveActivityDriver()
        let controller = FakeLiveActivityController()
        let snapshot = try snapshot()
        await driver.reconcile(snapshot: snapshot, followedTeamId: "team-c", controller: controller)
        await driver.reconcile(snapshot: snapshot, followedTeamId: nil, controller: controller)
        await driver.reconcile(snapshot: snapshot, followedTeamId: nil, controller: controller)
        await driver.reconcile(snapshot: nil, followedTeamId: nil, controller: controller)
        #expect(controller.ends == [snapshot.publicationId])
        await driver.reconcile(snapshot: snapshot, followedTeamId: "team-c", controller: controller)
        #expect(controller.starts.count == 2)
        #expect(controller.ends == [snapshot.publicationId])
    }

    @Test("an unknown team cannot start anything and clears a stale activity")
    @MainActor
    func unknownTeam() async throws {
        let driver = LiveActivityDriver()
        let controller = FakeLiveActivityController()
        let snapshot = try snapshot()
        await driver.reconcile(snapshot: snapshot, followedTeamId: "team-zzz", controller: controller)
        #expect(controller.starts.isEmpty)
        // A stale sweep: the system may still run an activity for a team since removed.
        #expect(controller.ends == [snapshot.publicationId])
        await driver.reconcile(snapshot: snapshot, followedTeamId: "team-c", controller: controller)
        await driver.reconcile(snapshot: snapshot, followedTeamId: "team-zzz", controller: controller)
        #expect(controller.starts.count == 1)
        #expect(controller.ends == [snapshot.publicationId, snapshot.publicationId])
    }

    @Test("relaunch with a surviving system activity adopts it instead of duplicating it")
    @MainActor
    func relaunchAdopts() async throws {
        let snapshot = try snapshot()
        let key = try #require(LiveActivityKey(snapshot: snapshot, followedTeamId: "team-c"))
        let driver = LiveActivityDriver()
        let controller = FakeLiveActivityController()
        controller.existing = [key]
        await driver.reconcile(snapshot: snapshot, followedTeamId: "team-c", controller: controller)
        #expect(controller.starts.isEmpty)
        #expect(controller.updates.count == 1)
        #expect(controller.ends.isEmpty)
    }

    @Test("relaunch with no surviving activity starts fresh")
    @MainActor
    func relaunchWithoutActivityStarts() async throws {
        let driver = LiveActivityDriver()
        let controller = FakeLiveActivityController()
        await driver.reconcile(
            snapshot: try snapshot(), followedTeamId: "team-c", controller: controller)
        #expect(controller.starts.count == 1)
        #expect(controller.updates.isEmpty)
    }

    @Test("the activity controller environment defaults to nil, so the Clip never drives one")
    @MainActor
    func controllerDefaultsToNil() {
        #expect(EnvironmentValues().liveActivityController == nil)
    }
}
