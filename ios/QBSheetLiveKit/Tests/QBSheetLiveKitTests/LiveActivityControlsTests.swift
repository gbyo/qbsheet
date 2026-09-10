import Foundation
import Testing
@testable import QBSheetLiveKit

private actor ActivityCallRecorder {
    private(set) var calls: [String] = []

    func append(_ call: String) {
        calls.append(call)
    }
}

struct LiveActivityControlsTests {
    @Test("full-app controls forward start, update, and end without changing the snapshot")
    @MainActor
    func forwardsCoordinatorActions() async throws {
        let data = try QBLiveFixtureTests.fixture("snapshot-default")
        let snapshot = try QBLiveCoding.decoder.decode(QBLiveSnapshot.self, from: data)
        let recorder = ActivityCallRecorder()
        let controls = LiveActivityControls(
            isRunning: true,
            activePublicationId: snapshot.publicationId,
            activeTeamId: "team-a",
            explanation: nil,
            start: { received, teamId in
                await recorder.append("start:\(received.publicationId):\(teamId):\(received.revision)")
            },
            update: { received, teamId in
                await recorder.append("update:\(received.publicationId):\(teamId):\(received.revision)")
            },
            end: { publicationId in
                await recorder.append("end:\(publicationId)")
            }
        )

        await controls.start(snapshot: snapshot, teamId: "team-a")
        await controls.update(snapshot: snapshot, teamId: "team-a")
        await controls.end(publicationId: snapshot.publicationId)

        #expect(await recorder.calls == [
            "start:\(snapshot.publicationId):team-a:\(snapshot.revision)",
            "update:\(snapshot.publicationId):team-a:\(snapshot.revision)",
            "end:\(snapshot.publicationId)",
        ])
    }
}
