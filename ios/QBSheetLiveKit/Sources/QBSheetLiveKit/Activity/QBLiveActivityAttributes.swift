import Foundation
#if canImport(ActivityKit)
import ActivityKit
#endif

/// The ActivityKit contract for QBSheet Live.
///
/// # Why the followed team is a static attribute
///
/// A broadcast push channel delivers the *same* `ContentState` to every subscriber. The part that
/// differs per viewer therefore cannot be in `ContentState`; it has to be in the attributes, which
/// are fixed when the Activity starts. So the shard's state is broadcast, and the view picks out
/// one team's entry using `slot`.
///
/// # Why the field names are one and two letters
///
/// Apple caps a broadcast payload at 5 120 bytes, and every JSON key is repeated once per team.
/// Measured sizes are in `docs/QBLIVE_ACTIVITY.md`; the encoder on the other side is
/// `packages/qblive-activity`, and both are tested against the same numbers.
public struct QBLiveActivityAttributes: Codable, Hashable, Sendable {
    /// One team's glanceable state. Everything optional is genuinely absent when the tournament
    /// has not published it — that is how a privacy setting reaches a Lock Screen.
    public struct TeamState: Codable, Hashable, Sendable {
        public enum Mode: Int, Codable, Sendable {
            case idle = 0
            case upcoming = 1
            case live = 2
            case final = 3
        }

        /// Index within the shard.
        public let i: Int
        public let m: Mode
        /// Opponent's index within the shard, when they are in it.
        public let o: Int?
        /// Opponent's short name, when they are in a different shard.
        public let on: String?
        public let s: Int?
        public let x: Int?
        public let u: Int?
        public let rm: String?
        public let rd: Int?
        /// Scheduled start, Unix seconds. Absent means the tournament stated no time.
        public let st: Int?
        /// A non-game event's title, for a team whose next thing is lunch.
        public let ev: String?

        public init(
            i: Int,
            m: Mode,
            o: Int? = nil,
            on: String? = nil,
            s: Int? = nil,
            x: Int? = nil,
            u: Int? = nil,
            rm: String? = nil,
            rd: Int? = nil,
            st: Int? = nil,
            ev: String? = nil
        ) {
            self.i = i
            self.m = m
            self.o = o
            self.on = on
            self.s = s
            self.x = x
            self.u = u
            self.rm = rm
            self.rd = rd
            self.st = st
            self.ev = ev
        }

        public var scheduledStart: Date? {
            st.map { Date(timeIntervalSince1970: TimeInterval($0)) }
        }
    }

    public struct ContentState: Codable, Hashable, Sendable {
        /// The publication revision this state came from. Used to discard a reordered update.
        public let r: Int
        /// One entry per team in the shard, in shard order.
        public let t: [TeamState]

        public init(r: Int, t: [TeamState]) {
            self.r = r
            self.t = t
        }

        /// The followed team's entry, or nil if the shard came back the wrong size.
        public func team(slot: Int) -> TeamState? {
            t.first { $0.i == slot } ?? (t.indices.contains(slot) ? t[slot] : nil)
        }
    }

    public let publicationId: String
    public let tournamentName: String
    public let followedTeamId: String
    public let followedTeamName: String
    public let shard: Int
    /// The followed team's index within the shard.
    public let slot: Int

    public init(
        publicationId: String,
        tournamentName: String,
        followedTeamId: String,
        followedTeamName: String,
        shard: Int,
        slot: Int
    ) {
        self.publicationId = publicationId
        self.tournamentName = tournamentName
        self.followedTeamId = followedTeamId
        self.followedTeamName = followedTeamName
        self.shard = shard
        self.slot = slot
    }
}

#if canImport(ActivityKit)
extension QBLiveActivityAttributes: ActivityAttributes {}
#endif

/// Sharding.
///
/// Channels are per shard of teams, never per team and never per viewer. A thousand people
/// following the same eight teams share one APNs channel. See `docs/QBLIVE.md#132-channel-sharding`.
public enum QBLiveSharding {
    /// The conservative default. Measurement says sixteen fits; this is the answer without
    /// measuring. See `packages/qblive-activity`.
    public static let defaultTeamsPerShard = 8

    public static func shard(forTeamIndex index: Int, teamsPerShard: Int = defaultTeamsPerShard) -> Int {
        index / max(1, teamsPerShard)
    }

    public static func slot(forTeamIndex index: Int, teamsPerShard: Int = defaultTeamsPerShard) -> Int {
        index % max(1, teamsPerShard)
    }

    public static func shardCount(teamCount: Int, teamsPerShard: Int = defaultTeamsPerShard) -> Int {
        let size = max(1, teamsPerShard)
        return (teamCount + size - 1) / size
    }

    /// A team's index within the tournament, from the published team order.
    ///
    /// The published order is the shared fact: Director derives the shard from it, and the client
    /// derives the same shard from the same list. Nothing has to be transmitted.
    public static func teamIndex(of teamId: String, in snapshot: QBLiveSnapshot) -> Int? {
        snapshot.teams.firstIndex { $0.id == teamId }
    }

    /// Build the attributes for a device following one team.
    public static func attributes(
        for teamId: String,
        in snapshot: QBLiveSnapshot,
        teamsPerShard: Int = defaultTeamsPerShard
    ) -> QBLiveActivityAttributes? {
        guard let index = teamIndex(of: teamId, in: snapshot) else { return nil }
        return QBLiveActivityAttributes(
            publicationId: snapshot.publicationId,
            tournamentName: snapshot.tournament.name,
            followedTeamId: teamId,
            followedTeamName: snapshot.teamName(teamId),
            shard: shard(forTeamIndex: index, teamsPerShard: teamsPerShard),
            slot: slot(forTeamIndex: index, teamsPerShard: teamsPerShard)
        )
    }
}

/// Derive a shard's content state from a snapshot.
///
/// Lives in the shared kit rather than only in the push gateway so that an Activity started while
/// the app is in the foreground shows the right thing immediately, without waiting for a push. The
/// gateway's TypeScript encoder produces the identical shape; `QBLiveActivityTests` checks the two
/// against the same fixture.
public enum QBLiveActivityState {
    public static func contentState(
        shard: Int,
        in snapshot: QBLiveSnapshot,
        teamsPerShard: Int = QBLiveSharding.defaultTeamsPerShard,
        now: Date = Date()
    ) -> QBLiveActivityAttributes.ContentState {
        let start = shard * teamsPerShard
        let members = Array(snapshot.teams.dropFirst(start).prefix(teamsPerShard))
        let states = members.enumerated().map { slot, team in
            teamState(slot: slot, team: team, shardTeamIds: members.map(\.id), snapshot: snapshot, now: now)
        }
        return QBLiveActivityAttributes.ContentState(r: snapshot.revision, t: states)
    }

    private static func teamState(
        slot: Int,
        team: QBLiveTeam,
        shardTeamIds: [String],
        snapshot: QBLiveSnapshot,
        now: Date
    ) -> QBLiveActivityAttributes.TeamState {
        if let live = snapshot.liveGame(for: team.id) {
            let opponentId = live.teamIds.first { $0 != team.id }
            return .init(
                i: slot,
                m: .live,
                o: shardTeamIds.firstIndex(of: opponentId ?? ""),
                on: shardTeamIds.contains(opponentId ?? "") ? nil : snapshot.teamName(opponentId),
                s: live.scores?.first { $0.teamId == team.id }.map { Int($0.score) },
                x: live.scores?.first { $0.teamId != team.id }.map { Int($0.score) },
                u: live.tossupsRead,
                rm: snapshot.room(live.roomId)?.name,
                rd: snapshot.schedule.first { $0.id == live.gameId }?.roundNumber.map(Int.init)
            )
        }
        if let next = snapshot.nextEvent(for: team.id, now: now) {
            if let game = next.game {
                let opponentId = game.opponent(of: team.id)
                return .init(
                    i: slot,
                    m: .upcoming,
                    o: shardTeamIds.firstIndex(of: opponentId ?? ""),
                    on: shardTeamIds.contains(opponentId ?? "") ? nil : snapshot.teamName(opponentId),
                    rm: snapshot.room(game.roomId)?.name,
                    rd: game.roundNumber.map(Int.init),
                    // Absent when the tournament stated no time. Never a computed estimate.
                    st: game.scheduledStart.map { Int($0.timeIntervalSince1970) }
                )
            }
            if let event = next.event {
                return .init(
                    i: slot,
                    m: .upcoming,
                    rm: snapshot.room(event.roomId)?.name ?? event.location,
                    st: event.scheduledStart.map { Int($0.timeIntervalSince1970) },
                    ev: event.title
                )
            }
        }
        if let recent = snapshot.recentResults(for: team.id, limit: 1).first {
            let ours = recent.scores.first { $0.teamId == team.id }?.score
            let theirs = recent.scores.first { $0.teamId != team.id }
            return .init(
                i: slot,
                m: .final,
                o: shardTeamIds.firstIndex(of: theirs?.teamId ?? ""),
                on: shardTeamIds.contains(theirs?.teamId ?? "") ? nil : snapshot.teamName(theirs?.teamId),
                s: ours.map(Int.init),
                x: theirs.map { Int($0.score) },
                rd: snapshot.schedule.first { $0.id == recent.gameId }?.roundNumber.map(Int.init)
            )
        }
        return .init(i: slot, m: .idle)
    }
}
