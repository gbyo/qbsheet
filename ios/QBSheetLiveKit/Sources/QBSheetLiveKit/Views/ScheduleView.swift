import SwiftUI

/// Schedule.
///
/// Defaults to the followed team; the whole public schedule is one tap away. Only released rounds
/// ever reach the client, so there is nothing on this screen to hide — the filtering happened in
/// Director's projection.
struct ScheduleView: View {
    let snapshot: QBLiveSnapshot
    let teamId: String

    @State private var scope: Scope = .team
    @State private var now = Date()
    private let clock = Timer.publish(every: 30, on: .main, in: .common).autoconnect()

    enum Scope: String, CaseIterable, Identifiable {
        case team, all
        var id: String { rawValue }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Picker("Schedule", selection: $scope) {
                Text(snapshot.teamName(teamId)).tag(Scope.team)
                Text("All games").tag(Scope.all)
            }
            .pickerStyle(.segmented)

            let events = snapshot.timeline.filter { ($0.scheduledEnd ?? .distantFuture) >= now }
            if scope == .team && !events.isEmpty {
                Section {
                    VStack(spacing: 0) {
                        ForEach(Array(events.enumerated()), id: \.element.id) { index, event in
                            if index > 0 { Divider() }
                            HStack {
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(event.title)
                                    if let subtitle = event.location ?? event.description {
                                        Text(subtitle).font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                                Spacer(minLength: 12)
                                if let start = event.scheduledStart {
                                    Text(LiveFormat.time(start, in: snapshot.tournament.resolvedTimeZone))
                                        .foregroundStyle(.secondary)
                                }
                            }
                            .padding(.horizontal, 16)
                            .padding(.vertical, 11)
                        }
                    }
                    .background(.background.secondary, in: RoundedRectangle(cornerRadius: 12))
                } header: {
                    SectionHeader("Today")
                }
            }

            let games = scope == .team ? snapshot.games(for: teamId) : snapshot.schedule
            if games.isEmpty {
                ContentUnavailableView(
                    "Nothing released yet",
                    systemImage: "calendar",
                    description: Text("Games appear here when the tournament releases them.")
                )
            } else {
                ForEach(rounds(of: games), id: \.id) { round in
                    Section {
                        VStack(spacing: 0) {
                            ForEach(Array(round.games.enumerated()), id: \.element.id) { index, game in
                                if index > 0 { Divider() }
                                ScheduleRow(
                                    game: game,
                                    snapshot: snapshot,
                                    followedTeamId: scope == .team ? teamId : nil
                                )
                            }
                        }
                        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 12))
                    } header: {
                        SectionHeader(round.title)
                    }
                }
            }
        }
        .onReceive(clock) { now = $0 }
    }

    private struct Round: Identifiable {
        let id: String
        let title: String
        let games: [QBLiveScheduledGame]
    }

    private func rounds(of games: [QBLiveScheduledGame]) -> [Round] {
        var order: [String] = []
        var byRound: [String: [QBLiveScheduledGame]] = [:]
        for game in games {
            if byRound[game.roundId] == nil { order.append(game.roundId) }
            byRound[game.roundId, default: []].append(game)
        }
        return order
            .compactMap { id -> Round? in
                guard let entries = byRound[id], let first = entries.first else { return nil }
                let title = scope == .all && first.poolName != nil
                    ? "\(first.roundName) · \(first.poolName!)"
                    : first.roundName
                return Round(id: id, title: title, games: entries)
            }
            .sorted {
                compareDayOrder($0.games.first, $1.games.first)
            }
    }
}

struct ScheduleRow: View {
    let game: QBLiveScheduledGame
    let snapshot: QBLiveSnapshot
    let followedTeamId: String?

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 12)
            trailing
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 11)
        .accessibilityElement(children: .combine)
    }

    private var title: String {
        if game.state == .bye { return "Bye" }
        if let followedTeamId {
            return "vs \(snapshot.teamName(game.opponent(of: followedTeamId)))"
        }
        return "\(snapshot.teamName(game.teamIds.first)) · \(snapshot.teamName(game.teamIds.dropFirst().first))"
    }

    private var subtitle: String {
        [
            game.roundName,
            snapshot.room(game.roomId)?.name,
            // Only when the tournament stated a time, and only before the game.
            game.state == .upcoming ? game.scheduledStart.map {
                LiveFormat.time($0, in: snapshot.tournament.resolvedTimeZone)
            } : nil,
        ]
        .compactMap { $0 }
        .joined(separator: " · ")
    }

    @ViewBuilder
    private var trailing: some View {
        if game.state == .cancelled {
            Text("Cancelled").foregroundStyle(.secondary)
        } else if let result = snapshot.result(for: game.id) {
            let scores = orderedScores(result)
            HStack(spacing: 6) {
                if followedTeamId != nil {
                    Text(scores.0 > scores.1 ? "W" : "L").fontWeight(.semibold)
                }
                Text("\(Int(scores.0))–\(Int(scores.1))")
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
        } else if game.state == .live {
            if let live = snapshot.liveGames.first(where: { $0.gameId == game.id }), let scores = live.scores {
                Text("\(Int(scores.first?.score ?? 0))–\(Int(scores.dropFirst().first?.score ?? 0))")
                    .foregroundStyle(.red)
                    .fontWeight(.semibold)
                    .monospacedDigit()
            } else {
                Label("Live", systemImage: "dot.radiowaves.left.and.right")
                    .labelStyle(.titleOnly)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.red)
            }
        } else if let start = game.scheduledStart {
            Text(LiveFormat.time(start, in: snapshot.tournament.resolvedTimeZone))
                .foregroundStyle(.secondary)
        }
        // Upcoming with no stated time draws nothing at all. Never a placeholder estimate.
    }

    private func orderedScores(_ result: QBLiveResult) -> (Double, Double) {
        if let followedTeamId {
            let ours = result.scores.first { $0.teamId == followedTeamId }?.score ?? 0
            let theirs = result.scores.first { $0.teamId != followedTeamId }?.score ?? 0
            return (ours, theirs)
        }
        return (result.scores.first?.score ?? 0, result.scores.dropFirst().first?.score ?? 0)
    }
}
