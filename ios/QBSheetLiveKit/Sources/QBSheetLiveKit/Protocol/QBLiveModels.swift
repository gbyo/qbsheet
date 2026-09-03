import Foundation

/// QBLive v1 wire types.
///
/// The Swift half of the contract described in `docs/QBLIVE.md` and expressed as JSON Schema in
/// `packages/qblive-protocol/schemas`. `QBLiveFixtureTests` decodes the same fixtures the
/// TypeScript suite reads, so a change on one side that is not made on the other fails a build.
///
/// Everything is a `struct` and `Sendable`: these cross an actor boundary between the networking
/// layer and SwiftUI on every update, and a reference type here would be a data race waiting for a
/// busy tournament.
public enum QBLive {
    public static let protocolVersion = 1
}

// MARK: - Capabilities

public struct QBLiveCapabilities: Codable, Hashable, Sendable {
    public let snapshot: Bool
    public let events: Bool
    public let stream: Bool
    public let applePush: Bool
    public let minimumReplayRevision: Int?

    public init(
        snapshot: Bool = true,
        events: Bool = false,
        stream: Bool = false,
        applePush: Bool = false,
        minimumReplayRevision: Int? = nil
    ) {
        self.snapshot = snapshot
        self.events = events
        self.stream = stream
        self.applePush = applePush
        self.minimumReplayRevision = minimumReplayRevision
    }

    /// Absent booleans decode as `false`.
    ///
    /// A QBLive server is allowed to omit a capability it does not have, and a client that refused
    /// the document over a missing optional would be refusing a conforming Basic server.
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        snapshot = try container.decodeIfPresent(Bool.self, forKey: .snapshot) ?? true
        events = try container.decodeIfPresent(Bool.self, forKey: .events) ?? false
        stream = try container.decodeIfPresent(Bool.self, forKey: .stream) ?? false
        applePush = try container.decodeIfPresent(Bool.self, forKey: .applePush) ?? false
        minimumReplayRevision = try container.decodeIfPresent(Int.self, forKey: .minimumReplayRevision)
    }
}

// MARK: - Tournament

public struct QBLiveTournament: Codable, Hashable, Sendable, Identifiable {
    public enum Status: String, Codable, Sendable {
        case upcoming
        case inProgress = "in-progress"
        case complete
    }

    public let id: String
    public let name: String
    public let date: String?
    public let venue: String?
    public let organizer: String?
    /// An IANA identifier. Times are formatted in this zone by default.
    public let timeZone: String
    public let status: Status

    /// The tournament's own zone, or the device's when the identifier is one this OS does not know.
    public var resolvedTimeZone: TimeZone {
        TimeZone(identifier: timeZone) ?? .current
    }
}

public struct QBLivePlayer: Codable, Hashable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let teamId: String
}

public struct QBLiveTeam: Codable, Hashable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let organization: String?
    public let seed: Double?
    /// Present only when the tournament publishes player names.
    public let players: [QBLivePlayer]?
}

public struct QBLiveRoom: Codable, Hashable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let building: String?
    public let directions: String?
}

// MARK: - Timeline and schedule

public struct QBLiveTimelineEvent: Codable, Hashable, Sendable, Identifiable {
    public enum Kind: String, Codable, Sendable {
        case round, lunch, custom, awards, ceremony
        case checkIn = "check-in"
        case breakTime = "break"

        /// An unknown future event type renders as a generic one rather than failing the decode.
        public init(from decoder: any Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Kind(rawValue: raw) ?? .custom
        }
    }

    public let id: String
    public let type: Kind
    public let title: String
    public let description: String?
    /// Explicit day-sequence position, or nil when the publisher predates day ordering.
    /// Missing keys decode as nil, so old snapshots keep decoding.
    public let sequence: Double?
    /// An actual scheduled time, or nil. Never an estimate; see `docs/QBLIVE.md#72-no-estimated-times`.
    public let scheduledStart: Date?
    public let scheduledEnd: Date?
    public let teamIds: [String]
    public let roomId: String?
    public let location: String?
}

public struct QBLiveScheduledGame: Codable, Hashable, Sendable, Identifiable {
    public enum State: String, Codable, Sendable {
        case upcoming, live, final, bye, cancelled

        public init(from decoder: any Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = State(rawValue: raw) ?? .upcoming
        }
    }

    public let id: String
    public let roundId: String
    public let roundName: String
    public let roundNumber: Double?
    /// Explicit day-sequence position of this game's round, or nil when the
    /// publisher predates day ordering. Missing keys decode as nil.
    public let sequence: Double?
    public let phaseId: String?
    public let phaseName: String?
    public let poolId: String?
    public let poolName: String?
    public let teamIds: [String]
    public let roomId: String?
    public let scheduledStart: Date?
    public let state: State

    public func opponent(of teamId: String) -> String? {
        teamIds.first { $0 != teamId }
    }
}

// MARK: - Results

public struct QBLiveTeamScore: Codable, Hashable, Sendable {
    public let teamId: String
    public let score: Double
}

public struct QBLiveResult: Codable, Hashable, Sendable, Identifiable {
    public enum Outcome: String, Codable, Sendable {
        case played, forfeit, cancelled

        public init(from decoder: any Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Outcome(rawValue: raw) ?? .played
        }
    }

    public let gameId: String
    public let roundId: String
    public let scores: [QBLiveTeamScore]
    public let outcome: Outcome
    public let acceptedAt: Date?

    public var id: String { gameId }
}

public struct QBLiveGameInProgress: Codable, Hashable, Sendable, Identifiable {
    public let gameId: String
    public let roundId: String
    public let teamIds: [String]
    public let roomId: String?
    /// Present only when the tournament publishes live scores.
    public let scores: [QBLiveTeamScore]?
    /// Present only when the tournament publishes live progress.
    public let tossupsRead: Int?

    public var id: String { gameId }
}

// MARK: - Dynamic tables

/// A column kind.
///
/// Deliberately not an enum with a fixed set. A Director that gains a statistic must be able to
/// publish a column this build has never heard of, and the client renders it from the cell's
/// `display` string. Turning that into a decoding failure would defeat the whole mechanism.
public struct QBLiveColumnKind: RawRepresentable, Codable, Hashable, Sendable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }

    public static let text = QBLiveColumnKind(rawValue: "text")
    public static let integer = QBLiveColumnKind(rawValue: "integer")
    public static let decimal = QBLiveColumnKind(rawValue: "decimal")
    public static let percentage = QBLiveColumnKind(rawValue: "percentage")
    public static let record = QBLiveColumnKind(rawValue: "record")
    public static let rank = QBLiveColumnKind(rawValue: "rank")
    public static let score = QBLiveColumnKind(rawValue: "score")
    public static let team = QBLiveColumnKind(rawValue: "team")
    public static let player = QBLiveColumnKind(rawValue: "player")

    /// Whether a value of this kind reads better right-aligned with tabular figures.
    public var isNumeric: Bool {
        [Self.integer, .decimal, .percentage, .record, .rank, .score].contains(self)
    }
}

public struct QBLiveColumn: Codable, Hashable, Sendable, Identifiable {
    public enum Alignment: String, Codable, Sendable {
        case leading, center, trailing
    }

    public let id: String
    public let label: String
    public let kind: QBLiveColumnKind
    public let alignment: Alignment?
    public let precision: Int?
    public let description: String?
}

public struct QBLiveCell: Codable, Hashable, Sendable {
    /// The raw value: a string, a number, or nothing.
    public enum Value: Codable, Hashable, Sendable {
        case text(String)
        case number(Double)
        case none

        public init(from decoder: any Decoder) throws {
            let container = try decoder.singleValueContainer()
            if container.decodeNil() {
                self = .none
            } else if let number = try? container.decode(Double.self) {
                self = .number(number)
            } else {
                self = .text(try container.decode(String.self))
            }
        }

        public func encode(to encoder: any Encoder) throws {
            var container = encoder.singleValueContainer()
            switch self {
            case .text(let value): try container.encode(value)
            case .number(let value): try container.encode(value)
            case .none: try container.encodeNil()
            }
        }
    }

    public let value: Value
    /// The server's own rendering. Authoritative: Director has already applied the tournament's
    /// formatting, and a client that re-derived the string would disagree with the printout.
    public let display: String?
    public let entityId: String?

    /// What to draw.
    public func text(precision: Int?) -> String {
        if let display { return display }
        switch value {
        case .text(let string): return string
        case .number(let number):
            if let precision { return String(format: "%.\(precision)f", number) }
            return number == number.rounded() ? String(Int(number)) : String(number)
        case .none: return "—"
        }
    }
}

public struct QBLiveRow: Codable, Hashable, Sendable, Identifiable {
    public let id: String
    public let cells: [QBLiveCell]
    public let teamId: String?
    public let playerId: String?
}

public struct QBLiveDataTable: Codable, Hashable, Sendable, Identifiable {
    public let id: String
    public let title: String
    public let scope: String
    public let scopeLabel: String?
    public let columns: [QBLiveColumn]
    public let rows: [QBLiveRow]
}

// MARK: - Announcements

public struct QBLiveAnnouncement: Codable, Hashable, Sendable, Identifiable {
    public enum Severity: String, Codable, Sendable {
        case information, important, urgent

        public init(from decoder: any Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Severity(rawValue: raw) ?? .information
        }
    }

    public let id: String
    public let title: String
    /// Plain text, always. Never rendered as markup: the server that supplied it is not ours.
    public let body: String
    public let severity: Severity
    public let publishedAt: Date
    public let updatedAt: Date?
    public let expiresAt: Date?
    public let audienceTeamIds: [String]
}

// MARK: - Snapshot, manifest, events

public struct QBLiveSnapshot: Codable, Hashable, Sendable {
    public let protocolVersion: Int
    public let publicationId: String
    public let revision: Int
    public let generatedAt: Date
    public let capabilities: QBLiveCapabilities
    public let final: Bool
    public let tournament: QBLiveTournament
    public let teams: [QBLiveTeam]
    public let rooms: [QBLiveRoom]
    public let timeline: [QBLiveTimelineEvent]
    public let schedule: [QBLiveScheduledGame]
    public let results: [QBLiveResult]
    public let liveGames: [QBLiveGameInProgress]
    public let standings: [QBLiveDataTable]
    public let statistics: [QBLiveDataTable]
    public let announcements: [QBLiveAnnouncement]
}

public struct QBLiveManifest: Codable, Hashable, Sendable {
    public struct Endpoints: Codable, Hashable, Sendable {
        public let snapshot: String
        public let events: String?
        public let stream: String?
    }

    public let protocolVersion: Int
    public let publicationId: String
    public let revision: Int
    public let generatedAt: Date
    public let tournament: QBLiveTournament
    public let capabilities: QBLiveCapabilities
    public let endpoints: Endpoints
    public let final: Bool
}

/// The sections an event may replace. Absent means unchanged.
public struct QBLiveSections: Codable, Hashable, Sendable {
    public let tournament: QBLiveTournament?
    public let teams: [QBLiveTeam]?
    public let rooms: [QBLiveRoom]?
    public let timeline: [QBLiveTimelineEvent]?
    public let schedule: [QBLiveScheduledGame]?
    public let results: [QBLiveResult]?
    public let liveGames: [QBLiveGameInProgress]?
    public let standings: [QBLiveDataTable]?
    public let statistics: [QBLiveDataTable]?
    public let announcements: [QBLiveAnnouncement]?
}

public struct QBLiveEvent: Codable, Hashable, Sendable {
    public let revision: Int
    public let generatedAt: Date
    public let sections: QBLiveSections
    public let final: Bool?
}

public struct QBLiveEventPage: Codable, Hashable, Sendable {
    public let protocolVersion: Int
    public let publicationId: String
    public let currentRevision: Int
    public let events: [QBLiveEvent]
    public let resyncRequired: Bool
}

public struct QBLiveErrorBody: Codable, Hashable, Sendable {
    public let error: String
    public let message: String
    public let currentRevision: Int?
}

// MARK: - Applying an event

public extension QBLiveSnapshot {
    /// Replace the sections an event names. Shared with Live Web's `applyEvent`, on purpose:
    /// "replace this section" has to mean the same thing on both clients.
    func applying(_ event: QBLiveEvent) -> QBLiveSnapshot {
        QBLiveSnapshot(
            protocolVersion: protocolVersion,
            publicationId: publicationId,
            revision: event.revision,
            generatedAt: event.generatedAt,
            capabilities: capabilities,
            final: event.final ?? final,
            tournament: event.sections.tournament ?? tournament,
            teams: event.sections.teams ?? teams,
            rooms: event.sections.rooms ?? rooms,
            timeline: event.sections.timeline ?? timeline,
            schedule: event.sections.schedule ?? schedule,
            results: event.sections.results ?? results,
            liveGames: event.sections.liveGames ?? liveGames,
            standings: event.sections.standings ?? standings,
            statistics: event.sections.statistics ?? statistics,
            announcements: event.sections.announcements ?? announcements
        )
    }
}
