import Foundation

/// Explicit day sequence first, then round number; sequenceless games keep
/// legacy order. Mirrors `compareOptionalSequence` in live-web derive.ts.
func compareDayOrder(_ left: QBLiveScheduledGame?, _ right: QBLiveScheduledGame?) -> Bool {
    let leftRank = left?.sequence ?? .greatestFiniteMagnitude
    let rightRank = right?.sequence ?? .greatestFiniteMagnitude
    if leftRank != rightRank { return leftRank < rightRank }
    return (left?.roundNumber ?? .greatestFiniteMagnitude)
        < (right?.roundNumber ?? .greatestFiniteMagnitude)
}

/// Reading a snapshot from a followed team's point of view.
///
/// The Swift counterpart of `apps/live-web/src/state/derive.ts`. The two are kept deliberately
/// parallel — same names, same rules — because a spectator with an iPhone and a spectator with a
/// Chromebook standing next to each other must be told the same thing.
public extension QBLiveSnapshot {
    func team(_ id: String?) -> QBLiveTeam? {
        guard let id else { return nil }
        return teams.first { $0.id == id }
    }

    func teamName(_ id: String?) -> String {
        team(id)?.name ?? "—"
    }

    func room(_ id: String?) -> QBLiveRoom? {
        guard let id else { return nil }
        return rooms.first { $0.id == id }
    }

    func games(for teamId: String) -> [QBLiveScheduledGame] {
        schedule.filter { $0.teamIds.contains(teamId) }
    }

    func liveGame(for teamId: String) -> QBLiveGameInProgress? {
        liveGames.first { $0.teamIds.contains(teamId) }
    }

    func result(for gameId: String) -> QBLiveResult? {
        results.first { $0.gameId == gameId }
    }

    func player(_ id: String?) -> QBLivePlayer? {
        guard let id else { return nil }
        for team in teams {
            if let match = team.players?.first(where: { $0.id == id }) { return match }
        }
        return nil
    }

    /// Whether the tournament publishes player-level information at all.
    var publishesPlayers: Bool {
        teams.contains { ($0.players?.isEmpty == false) }
    }

    /// The team's next public commitment: a game or a timeline event, whichever comes first.
    ///
    /// Games and events are considered together, because a team's next thing at 12:05 is lunch, not
    /// the round after it. Anything without a stated time sorts after everything with one, rather
    /// than being given a guessed position.
    func nextEvent(for teamId: String, now: Date = Date()) -> NextEvent? {
        var candidates: [NextEvent] = []
        for game in games(for: teamId) where game.state != .final && game.state != .cancelled {
            candidates.append(NextEvent(game: game))
        }
        for event in timeline {
            if !event.teamIds.isEmpty && !event.teamIds.contains(teamId) { continue }
            if let end = event.scheduledEnd, end < now { continue }
            candidates.append(NextEvent(event: event))
        }
        guard !candidates.isEmpty else { return nil }

        if let live = candidates.first(where: { $0.game?.state == .live }) { return live }

        let timed = candidates
            .filter { $0.scheduledStart != nil }
            .filter { $0.scheduledStart! >= now.addingTimeInterval(-90 * 60) }
            .sorted { $0.scheduledStart! < $1.scheduledStart! }
        if let soonest = timed.first { return soonest }

        // Nothing has a usable time. The first unfinished game in day-sequence order,
        // then round number, shown with no time.
        return candidates
            .filter { $0.game != nil }
            .sorted { compareDayOrder($0.game, $1.game) }
            .first ?? candidates.first
    }

    func recentResults(for teamId: String, limit: Int = 4) -> [QBLiveResult] {
        let ids = Set(games(for: teamId).map(\.id))
        return results
            .filter { ids.contains($0.gameId) }
            .sorted { ($0.acceptedAt ?? .distantPast) > ($1.acceptedAt ?? .distantPast) }
            .prefix(limit)
            .map { $0 }
    }

    /// The team's placement as Director's own table reports it.
    ///
    /// Read out of the table rather than recomputed: Director is authoritative for placement, and a
    /// client that derived its own rank would contradict the printout the first time a tiebreaker
    /// mattered. See `docs/QBLIVE.md#10-dynamic-tables`.
    func placement(for teamId: String) -> Placement? {
        guard let table = standings.first(where: { $0.scope == "overall" }) ?? standings.first,
              let index = table.rows.firstIndex(where: { $0.teamId == teamId })
        else { return nil }
        let rankColumn = table.columns.firstIndex { $0.kind == .rank }
        let rank: Int
        if let rankColumn, case .number(let value) = table.rows[index].cells[rankColumn].value {
            rank = Int(value)
        } else {
            rank = index + 1
        }
        return Placement(rank: rank, of: table.rows.count, tableTitle: table.scopeLabel ?? table.title)
    }

    func placement(forPlayer playerId: String) -> Placement? {
        for table in statistics {
            if let index = table.rows.firstIndex(where: { $0.playerId == playerId }) {
                return Placement(rank: index + 1, of: table.rows.count, tableTitle: table.title)
            }
        }
        return nil
    }

    func announcements(for teamId: String?, now: Date = Date()) -> [QBLiveAnnouncement] {
        announcements.filter { announcement in
            if let expiry = announcement.expiresAt, expiry <= now { return false }
            if announcement.audienceTeamIds.isEmpty { return true }
            guard let teamId else { return false }
            return announcement.audienceTeamIds.contains(teamId)
        }
    }

    struct Placement: Hashable, Sendable {
        public let rank: Int
        public let of: Int
        public let tableTitle: String
    }

    struct NextEvent: Hashable, Sendable, Identifiable {
        public let game: QBLiveScheduledGame?
        public let event: QBLiveTimelineEvent?

        init(game: QBLiveScheduledGame) {
            self.game = game
            self.event = nil
        }

        init(event: QBLiveTimelineEvent) {
            self.game = nil
            self.event = event
        }

        public var id: String { game?.id ?? event?.id ?? "" }

        /// The stated time, or nil. Never an estimate.
        public var scheduledStart: Date? { game?.scheduledStart ?? event?.scheduledStart }
    }
}
