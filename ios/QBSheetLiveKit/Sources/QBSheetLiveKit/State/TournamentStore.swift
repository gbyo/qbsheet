import Foundation
import Observation

/// The app's single source of truth for one tournament.
///
/// Shared by the full app and the App Clip. `@Observable` rather than `ObservableObject`, and
/// `@MainActor` throughout: every property here is read during a SwiftUI body evaluation, and the
/// alternative is a hop per read on a screen that updates on every tossup.
///
/// # What is stored, and where
///
/// The followed team and the selected player are personalization on this device. They authorize
/// nothing: a parent, a coach, a player and a stranger can all follow any public team, and choosing
/// a player highlights rows without verifying anybody's identity.
///
/// Everything goes in the App Group container so the full app inherits what the App Clip learned.
@MainActor
@Observable
public final class TournamentStore {
    public enum Connection: Equatable, Sendable {
        case loading
        case live
        case polling
        case offline(String)
        case failed(String)
    }

    public private(set) var snapshot: QBLiveSnapshot?
    public private(set) var connection: Connection = .loading
    /// When this device received what it is showing. Drives the staleness line.
    public private(set) var receivedAt: Date?
    public private(set) var bootstrap: QBLiveBootstrap?

    public var followedTeamId: String? {
        didSet { persistence.followedTeamId = followedTeamId }
    }

    public var selectedPlayerId: String? {
        didSet { persistence.selectedPlayerId = selectedPlayerId }
    }

    private let persistence: LivePersistence
    private var client: QBLiveClient?
    private var streamTask: Task<Void, Never>?
    private var pollTask: Task<Void, Never>?
    private var reconnectAttempts = 0

    public init(persistence: LivePersistence = .shared) {
        self.persistence = persistence
        self.followedTeamId = persistence.followedTeamId
        self.selectedPlayerId = persistence.selectedPlayerId
    }

    // MARK: - Lifecycle

    /// Open a tournament.
    ///
    /// Restores the cached snapshot first so the first frame is the tournament rather than a
    /// spinner — which matters most in the App Clip, where the whole point is to be instant.
    public func open(_ bootstrap: QBLiveBootstrap) async {
        if self.bootstrap != bootstrap {
            // A different tournament. The previous tournament's team is meaningless here.
            if self.bootstrap != nil {
                followedTeamId = nil
                selectedPlayerId = nil
            }
            snapshot = nil
            receivedAt = nil
        }
        self.bootstrap = bootstrap
        persistence.lastBootstrap = bootstrap

        if let cached = persistence.cachedSnapshot(for: bootstrap.publicationId) {
            snapshot = cached.snapshot
            receivedAt = cached.receivedAt
            connection = .offline("Showing the last update this device received.")
            restoreSelections(in: cached.snapshot)
        } else {
            connection = .loading
        }

        client = QBLiveClient(bootstrap: bootstrap)
        await refresh()
    }

    public func close() {
        streamTask?.cancel()
        pollTask?.cancel()
        streamTask = nil
        pollTask = nil
    }

    /// Pull-to-refresh, the Refresh button, and returning to the foreground.
    public func refresh() async {
        guard let client, let bootstrap else { return }
        do {
            let manifest = try await client.manifest()
            if snapshot?.revision != manifest.revision || snapshot == nil {
                let fresh = try await client.snapshot()
                apply(fresh)
            }
            reconnectAttempts = 0
            if manifest.capabilities.stream, let url = bootstrap.streamURL(capabilities: manifest.capabilities) {
                startStream(url: url)
            } else {
                connection = .polling
                startPolling()
            }
        } catch let failure as QBLiveClient.Failure {
            handle(failure)
        } catch {
            handle(.network("The tournament server could not be reached."))
        }
    }

    // MARK: - Realtime

    private func startStream(url: URL) {
        guard streamTask == nil else { return }
        pollTask?.cancel()
        pollTask = nil
        streamTask = Task { [weak self] in
            let stream = QBLiveStream(url: url)
            await self?.setConnection(.live)
            for await frame in await stream.frames() {
                guard let self else { return }
                await self.consume(frame)
            }
            // The socket closed. Fall back to polling immediately so the screen keeps updating, and
            // try the socket again with backoff.
            guard let self else { return }
            await self.streamClosed()
        }
    }

    private func setConnection(_ next: Connection) {
        connection = next
    }

    private func streamClosed() async {
        streamTask = nil
        guard !Task.isCancelled else { return }
        connection = .polling
        startPolling()
        reconnectAttempts += 1
        // Full jitter. Every phone in a gym loses the same access point at the same moment, and a
        // synchronised reconnect is a self-inflicted load spike on the tournament's own backend.
        let ceiling = min(60.0, pow(2.0, Double(min(reconnectAttempts, 6))))
        let delay = ceiling / 2 + Double.random(in: 0...(ceiling / 2))
        try? await Task.sleep(for: .seconds(delay))
        guard !Task.isCancelled else { return }
        await refresh()
    }

    private func consume(_ frame: QBLiveFrame) async {
        switch frame {
        case .hello(let revision):
            if let current = snapshot, revision > current.revision {
                await catchUp(after: current.revision)
            }
        case .resync, .final:
            await refresh()
        case .event(let event):
            guard let current = snapshot else { return }
            // Stale updates are dropped rather than applied: both APNs and a reconnecting socket
            // can deliver out of order, and a score that goes backwards is worse than a late one.
            if event.revision <= current.revision { return }
            if event.revision > current.revision + 1 {
                await catchUp(after: current.revision)
                return
            }
            apply(current.applying(event))
        }
    }

    private func catchUp(after revision: Int) async {
        guard let client else { return }
        do {
            let page = try await client.events(after: revision)
            if page.resyncRequired {
                await refresh()
                return
            }
            guard var current = snapshot else {
                await refresh()
                return
            }
            for event in page.events where event.revision > current.revision {
                current = current.applying(event)
            }
            apply(current)
        } catch {
            await refresh()
        }
    }

    /// Poll only while the app is in front. A backgrounded app gets its glanceable state from the
    /// Live Activity, and polling it would spend a spectator's battery on a screen nobody sees.
    private func startPolling() {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                guard let self, !Task.isCancelled else { return }
                await self.poll()
            }
        }
    }

    private func poll() async {
        guard let client else { return }
        do {
            let manifest = try await client.manifest()
            if manifest.revision != snapshot?.revision {
                apply(try await client.snapshot())
            }
            connection = .polling
            reconnectAttempts = 0
        } catch let failure as QBLiveClient.Failure {
            handle(failure)
        } catch {
            handle(.network("The tournament server could not be reached."))
        }
    }

    // MARK: - Applying

    private func apply(_ fresh: QBLiveSnapshot) {
        snapshot = fresh
        receivedAt = Date()
        restoreSelections(in: fresh)
        persistence.cache(fresh)
    }

    /// Drop a followed team or player that is no longer in the tournament.
    ///
    /// Teams do withdraw and rosters do change. A Home tab about a team that is not there any more
    /// is worse than being asked to choose again.
    private func restoreSelections(in fresh: QBLiveSnapshot) {
        if let team = followedTeamId, !fresh.teams.contains(where: { $0.id == team }) {
            followedTeamId = nil
            selectedPlayerId = nil
        }
        if let player = selectedPlayerId,
           !fresh.teams.contains(where: { $0.players?.contains { $0.id == player } ?? false })
        {
            selectedPlayerId = nil
        }
    }

    private func handle(_ failure: QBLiveClient.Failure) {
        if failure.isPermanent && snapshot == nil {
            connection = .failed(failure.localizedDescription)
            return
        }
        // Keep what we have on screen and say how old it is. Never a blank page over a blip.
        connection = .offline(failure.localizedDescription)
        startPolling()
    }
}
