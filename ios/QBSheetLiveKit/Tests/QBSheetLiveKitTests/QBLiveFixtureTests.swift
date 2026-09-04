import Foundation
import Testing
@testable import QBSheetLiveKit

/// The Swift half of the cross-language protocol contract.
///
/// These read the same `packages/qblive-protocol/fixtures` the TypeScript suite and the Cloudflare
/// backend read. A field added on one side and not the other fails here, which is the only thing
/// standing between three implementations of QBLive and three slightly different protocols.
struct QBLiveFixtureTests {
    static func fixture(_ name: String) throws -> Data {
        let url = try #require(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"))
        return try Data(contentsOf: url)
    }

    @Test("every snapshot fixture decodes")
    func snapshotsDecode() throws {
        for name in ["snapshot-default", "snapshot-maximal", "snapshot-minimal"] {
            let snapshot = try QBLiveCoding.decoder.decode(QBLiveSnapshot.self, from: Self.fixture(name))
            #expect(snapshot.protocolVersion == QBLive.protocolVersion)
            #expect(snapshot.publicationId == "bcdfghjkmnpqrstvwxyz")
            #expect(snapshot.tournament.timeZone == "America/New_York")
        }
    }

    @Test("the manifest and event page decode")
    func manifestAndEventsDecode() throws {
        let manifest = try QBLiveCoding.decoder.decode(QBLiveManifest.self, from: Self.fixture("manifest"))
        #expect(manifest.capabilities.stream)
        #expect(manifest.endpoints.snapshot.contains("snapshot"))

        let page = try QBLiveCoding.decoder.decode(QBLiveEventPage.self, from: Self.fixture("events"))
        #expect(page.currentRevision == 43)
        #expect(page.events.count == 2)
        #expect(!page.resyncRequired)
    }

    @Test("timestamps carry the tournament's offset, not the device's")
    func timestampsAreZoned() throws {
        let snapshot = try QBLiveCoding.decoder.decode(QBLiveSnapshot.self, from: Self.fixture("snapshot-default"))
        let lunch = try #require(snapshot.timeline.first)
        let start = try #require(lunch.scheduledStart)
        // 2026-09-05T12:00:00-04:00 is 16:00 UTC.
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC")!
        #expect(utc.component(.hour, from: start) == 16)
    }

    @Test("an untimed event between rounds wins by published sequence")
    func untimedEventUsesPublishedSequence() throws {
        var object = try #require(
            try JSONSerialization.jsonObject(with: Self.fixture("snapshot-default")) as? [String: Any]
        )
        let sourceSchedule = try #require(object["schedule"] as? [[String: Any]])

        var before = sourceSchedule[0]
        before["id"] = "game-before"
        before["roundId"] = "round-before"
        before["roundName"] = "Round 2"
        before["roundNumber"] = 2
        before["sequence"] = 1
        before["scheduledStart"] = NSNull()
        before["state"] = "upcoming"

        var after = sourceSchedule[2]
        after["id"] = "game-after"
        after["roundId"] = "round-after"
        after["roundName"] = "Round 3"
        after["roundNumber"] = 3
        after["sequence"] = 3
        after["scheduledStart"] = NSNull()
        after["state"] = "upcoming"

        object["schedule"] = [before, after]
        object["liveGames"] = []
        object["timeline"] = [[
            "id": "event-between",
            "type": "lunch",
            "title": "Lunch",
            "description": NSNull(),
            "sequence": 2,
            "scheduledStart": NSNull(),
            "scheduledEnd": NSNull(),
            "teamIds": ["team-a"],
            "roomId": NSNull(),
            "location": NSNull(),
        ]]

        // The earliest sequence wins whatever kind it is, so an unfinished Round 2 still comes
        // before Lunch. Asserting this direction too is what stops the fix over-correcting into
        // "events first".
        let data = try JSONSerialization.data(withJSONObject: object)
        let snapshot = try QBLiveCoding.decoder.decode(QBLiveSnapshot.self, from: data)
        let beforeLunch = try #require(snapshot.nextEvent(for: "team-a"))
        #expect(beforeLunch.game?.id == "game-before")

        // Once Round 2 is played, Lunch is next — not Round 3. This is the regression: an untimed
        // event used to be dropped from the fallback entirely, so Round 3 won on round number.
        before["state"] = "final"
        object["schedule"] = [before, after]
        let played = try JSONSerialization.data(withJSONObject: object)
        let afterRound = try QBLiveCoding.decoder.decode(QBLiveSnapshot.self, from: played)
        let next = try #require(afterRound.nextEvent(for: "team-a"))
        #expect(next.event?.id == "event-between")
    }

    @Test("a timestamp with no offset is rejected rather than assumed to be UTC")
    func bareTimestampRejected() {
        #expect(QBLiveCoding.parseTimestamp("2026-09-05T13:30:00") == nil)
        #expect(QBLiveCoding.parseTimestamp("2026-09-05T13:30:00Z") != nil)
        #expect(QBLiveCoding.parseTimestamp("2026-09-05T13:30:00-04:00") != nil)
        #expect(QBLiveCoding.parseTimestamp("2026-09-05T13:30:00.123-04:00") != nil)
    }

    @Test("an unknown column kind survives decoding")
    func unknownColumnKind() throws {
        // The whole point of dynamic tables: a Director that gains a statistic must not need an
        // App Store release.
        var object = try #require(
            try JSONSerialization.jsonObject(with: Self.fixture("snapshot-default")) as? [String: Any]
        )
        var standings = try #require(object["standings"] as? [[String: Any]])
        var table = standings[0]
        var columns = try #require(table["columns"] as? [[String: Any]])
        columns.append(["id": "future", "label": "Zing", "kind": "quantum-flux"])
        table["columns"] = columns
        var rows = try #require(table["rows"] as? [[String: Any]])
        rows = rows.map { row in
            var copy = row
            var cells = (copy["cells"] as? [[String: Any]]) ?? []
            cells.append(["value": 7, "display": "seven"])
            copy["cells"] = cells
            return copy
        }
        table["rows"] = rows
        standings[0] = table
        object["standings"] = standings

        let data = try JSONSerialization.data(withJSONObject: object)
        let snapshot = try QBLiveCoding.decoder.decode(QBLiveSnapshot.self, from: data)
        #expect(snapshot.standings[0].columns.last?.kind.rawValue == "quantum-flux")
        #expect(snapshot.standings[0].rows[0].cells.last?.text(precision: nil) == "seven")
    }

    @Test("an unknown timeline event type decodes as a generic event")
    func unknownTimelineType() throws {
        let json = """
        {
          "id": "x", "type": "solar-eclipse", "title": "Eclipse", "description": null,
          "scheduledStart": null, "scheduledEnd": null, "teamIds": [], "roomId": null, "location": null
        }
        """
        let event = try QBLiveCoding.decoder.decode(QBLiveTimelineEvent.self, from: Data(json.utf8))
        #expect(event.type == .custom)
        #expect(event.title == "Eclipse")
    }

    @Test("applying an event replaces exactly the sections it names")
    func applyingEvents() throws {
        let snapshot = try QBLiveCoding.decoder.decode(QBLiveSnapshot.self, from: Self.fixture("snapshot-default"))
        let page = try QBLiveCoding.decoder.decode(QBLiveEventPage.self, from: Self.fixture("events"))
        let applied = page.events.reduce(snapshot) { $0.applying($1) }
        #expect(applied.revision == 43)
        #expect(applied.teams == snapshot.teams)
        #expect(applied.results == page.events[1].sections.results)
    }

    @Test("what the default settings publish, and what they do not")
    func defaultPrivacy() throws {
        let snapshot = try QBLiveCoding.decoder.decode(QBLiveSnapshot.self, from: Self.fixture("snapshot-default"))
        // Live scores are off by default, so a game in progress carries no score.
        let live = try #require(snapshot.liveGames.first)
        #expect(live.scores == nil)
        #expect(live.tossupsRead == nil)
        // Player names are off by default, so no roster and no individual statistics.
        #expect(!snapshot.publishesPlayers)
        #expect(!snapshot.statistics.contains { $0.id.hasPrefix("player-statistics") })
    }

    @Test("the maximal fixture publishes what the default one withholds")
    func maximalPrivacy() throws {
        let snapshot = try QBLiveCoding.decoder.decode(QBLiveSnapshot.self, from: Self.fixture("snapshot-maximal"))
        #expect(snapshot.liveGames.first?.scores?.count == 2)
        #expect(snapshot.publishesPlayers)
        #expect(snapshot.statistics.contains { $0.id.hasPrefix("player-statistics") })
    }
}
