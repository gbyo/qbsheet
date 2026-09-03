import Foundation
import Testing
@testable import QBSheetLiveKit

/// Sharding and the broadcast payload.
///
/// The size numbers here must agree with `packages/qblive-activity/tests/payload.test.ts`, because
/// the gateway encodes what this decodes. See `docs/QBLIVE_ACTIVITY.md`.
struct QBLiveActivityTests {
    /// Apple's documented ceiling for a broadcast push payload.
    static let payloadLimit = 5120

    func snapshot() throws -> QBLiveSnapshot {
        try QBLiveCoding.decoder.decode(
            QBLiveSnapshot.self,
            from: try QBLiveFixtureTests.fixture("snapshot-maximal")
        )
    }

    @Test("channels scale with shards, not with viewers")
    func shardMath() {
        #expect(QBLiveSharding.shardCount(teamCount: 64) == 8)
        #expect(QBLiveSharding.shardCount(teamCount: 65) == 9)
        #expect(QBLiveSharding.shardCount(teamCount: 0) == 0)
        #expect(QBLiveSharding.shard(forTeamIndex: 7) == 0)
        #expect(QBLiveSharding.shard(forTeamIndex: 8) == 1)
        #expect(QBLiveSharding.slot(forTeamIndex: 15) == 7)
    }

    @Test("attributes name the followed team and its shard")
    func attributes() throws {
        let snapshot = try snapshot()
        let attributes = try #require(QBLiveSharding.attributes(for: "team-c", in: snapshot))
        #expect(attributes.followedTeamName == "Greenwood A")
        #expect(attributes.shard == 0)
        #expect(attributes.slot == 2)
        #expect(attributes.publicationId == snapshot.publicationId)
    }

    @Test("a live game becomes a live shard entry with the published score")
    func liveEntry() throws {
        let snapshot = try snapshot()
        let state = QBLiveActivityState.contentState(shard: 0, in: snapshot)
        #expect(state.r == snapshot.revision)
        let team = try #require(state.team(slot: 0))
        #expect(team.m == .live)
        #expect(team.s == 180)
        #expect(team.x == 135)
        #expect(team.u == 13)
        #expect(team.rm == "Room 104")
    }

    @Test("a tournament that does not publish scores produces an entry with no score")
    func withheldScore() throws {
        let snapshot = try QBLiveCoding.decoder.decode(
            QBLiveSnapshot.self,
            from: try QBLiveFixtureTests.fixture("snapshot-default")
        )
        let state = QBLiveActivityState.contentState(shard: 0, in: snapshot)
        let team = try #require(state.team(slot: 0))
        #expect(team.m == .live)
        // Absent, not zero. A Lock Screen that showed 0–0 would be stating a score.
        #expect(team.s == nil)
        #expect(team.u == nil)
    }

    @Test("a team with no stated start time carries no start time")
    func noInventedTime() throws {
        var snapshot = try snapshot()
        let stripped = snapshot.schedule.map { game in
            QBLiveScheduledGame(
                id: game.id, roundId: game.roundId, roundName: game.roundName, roundNumber: game.roundNumber,
                sequence: game.sequence,
                phaseId: game.phaseId, phaseName: game.phaseName, poolId: game.poolId, poolName: game.poolName,
                teamIds: game.teamIds, roomId: game.roomId, scheduledStart: nil, state: game.state
            )
        }
        snapshot = QBLiveSnapshot(
            protocolVersion: snapshot.protocolVersion, publicationId: snapshot.publicationId,
            revision: snapshot.revision, generatedAt: snapshot.generatedAt, capabilities: snapshot.capabilities,
            final: snapshot.final, tournament: snapshot.tournament, teams: snapshot.teams, rooms: snapshot.rooms,
            timeline: [], schedule: stripped, results: [], liveGames: [], standings: snapshot.standings,
            statistics: snapshot.statistics, announcements: snapshot.announcements
        )
        let state = QBLiveActivityState.contentState(shard: 0, in: snapshot)
        #expect(state.t.allSatisfy { $0.st == nil })
    }

    @Test("an eight-team shard is far inside Apple's broadcast payload limit")
    func payloadSize() throws {
        let snapshot = try snapshot()
        let state = QBLiveActivityState.contentState(shard: 0, in: snapshot)
        let payload: [String: Any] = [
            "aps": [
                "timestamp": 1_757_088_000,
                "event": "update",
                "content-state": try JSONSerialization.jsonObject(
                    with: try QBLiveCoding.encoder.encode(state)
                ),
            ],
        ]
        let bytes = try JSONSerialization.data(withJSONObject: payload).count
        #expect(bytes < Self.payloadLimit)
        // And with the headroom the measurement in `packages/qblive-activity` claims.
        #expect(bytes < Int(Double(Self.payloadLimit) * 0.6))
    }

    @Test("the Swift and TypeScript encodings agree on field names")
    func fieldNames() throws {
        let state = QBLiveActivityAttributes.ContentState(
            r: 41,
            t: [.init(i: 0, m: .live, o: 1, s: 180, x: 135, u: 13, rm: "104", rd: 2)]
        )
        let object = try #require(
            try JSONSerialization.jsonObject(with: try QBLiveCoding.encoder.encode(state)) as? [String: Any]
        )
        #expect(Set(object.keys) == ["r", "t"])
        let first = try #require((object["t"] as? [[String: Any]])?.first)
        // Exactly the keys `packages/qblive-activity` emits. A rename on one side fails here.
        #expect(Set(first.keys) == ["i", "m", "o", "s", "x", "u", "rm", "rd"])
        #expect(first["m"] as? Int == 2)
    }
}
