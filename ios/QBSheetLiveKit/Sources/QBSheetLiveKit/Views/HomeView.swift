import SwiftUI

/// Home: one team's day.
///
/// The largest thing on the screen answers "where does my team go next", and nothing on it is
/// invented. When the tournament has stated no time, no time appears — see
/// `docs/QBLIVE.md#72-no-estimated-times`.
struct HomeView: View {
    let snapshot: QBLiveSnapshot
    let teamId: String
    let selectedPlayerId: String?

    var body: some View {
        // Home has time-sensitive presentation even when no network snapshot changes: a scheduled
        // event can become "next" and announcements can expire. Let SwiftUI own those lightweight
        // refreshes instead of keeping a Combine timer alive with the view.
        TimelineView(.periodic(from: .now, by: 30)) { context in
            VStack(alignment: .leading, spacing: 20) {
                if let announcement = headline(now: context.date) {
                    AnnouncementCard(announcement: announcement, snapshot: snapshot, compact: true)
                }

                nextCard(now: context.date)

                if let placement = snapshot.placement(for: teamId) {
                    Section {
                        VStack(spacing: 0) {
                            PlacementRow(
                                title: snapshot.teamName(teamId),
                                subtitle: placement.tableTitle,
                                rank: placement.rank,
                                of: placement.of
                            )
                            if let playerId = selectedPlayerId,
                               let player = snapshot.player(playerId),
                               let playerPlacement = snapshot.placement(forPlayer: playerId)
                            {
                                Divider()
                                PlacementRow(
                                    title: player.name,
                                    subtitle: playerPlacement.tableTitle,
                                    rank: playerPlacement.rank,
                                    of: playerPlacement.of
                                )
                            }
                        }
                        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 12))
                    } header: {
                        SectionHeader("Placement")
                    }
                }

                let recent = snapshot.recentResults(for: teamId)
                if !recent.isEmpty {
                    Section {
                        VStack(spacing: 0) {
                            ForEach(Array(recent.enumerated()), id: \.element.gameId) { index, result in
                                if index > 0 { Divider() }
                                ResultRow(result: result, snapshot: snapshot, teamId: teamId)
                            }
                        }
                        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 12))
                    } header: {
                        SectionHeader("Recent results")
                    }
                }

                Text(footer)
                    .font(.footnote)
                    .foregroundStyle(.tertiary)
            }
        }
    }

    private func headline(now: Date) -> QBLiveAnnouncement? {
        let visible = snapshot.announcements(for: teamId, now: now)
        return visible.first { $0.severity == .urgent } ?? visible.first { $0.severity == .important }
    }

    @ViewBuilder
    private func nextCard(now: Date) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if let live = snapshot.liveGame(for: teamId) {
                Label("Now playing", systemImage: "dot.radiowaves.left.and.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.red)
                    .textCase(.uppercase)
                LiveScoreView(live: live, snapshot: snapshot, teamId: teamId)
                DetailLine(items: [
                    snapshot.room(live.roomId)?.name,
                    live.tossupsRead.map { "TU \($0)" },
                ])
            } else if let next = snapshot.nextEvent(for: teamId, now: now) {
                Text("Next")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tint)
                    .textCase(.uppercase)
                NextEventView(next: next, snapshot: snapshot, teamId: teamId)
            } else {
                Text("Next")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tint)
                    .textCase(.uppercase)
                Text("Nothing scheduled")
                    .font(.title2.weight(.semibold))
                Text(
                    snapshot.tournament.status == .complete
                        ? "The tournament is over."
                        : "Nothing further has been released yet."
                )
                .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 12))
    }

    private var footer: String {
        [snapshot.tournament.name, snapshot.tournament.venue]
            .compactMap { $0 }
            .joined(separator: " · ")
    }
}

struct NextEventView: View {
    let next: QBLiveSnapshot.NextEvent
    let snapshot: QBLiveSnapshot
    let teamId: String

    var body: some View {
        if let event = next.event {
            Text(event.title)
                .font(.title2.weight(.semibold))
            DetailLine(items: [
                formattedTime(event.scheduledStart),
                event.location,
                snapshot.room(event.roomId)?.name,
            ])
            if let description = event.description {
                Divider().padding(.vertical, 4)
                Text(description)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        } else if let game = next.game {
            Text(game.state == .bye ? "Bye" : "vs \(snapshot.teamName(game.opponent(of: teamId)))")
                .font(.title2.weight(.semibold))
            DetailLine(items: [
                game.roundName,
                // Nil when the tournament stated no time, and then nothing is drawn.
                formattedTime(game.scheduledStart),
                snapshot.room(game.roomId)?.name,
            ])
            if let directions = snapshot.room(game.roomId)?.directions {
                Divider().padding(.vertical, 4)
                Text(directions)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func formattedTime(_ date: Date?) -> String? {
        date.map { LiveFormat.time($0, in: snapshot.tournament.resolvedTimeZone) }
    }
}

struct LiveScoreView: View {
    let live: QBLiveGameInProgress
    let snapshot: QBLiveSnapshot
    let teamId: String

    var body: some View {
        let opponentId = live.teamIds.first { $0 != teamId }
        if let scores = live.scores {
            let ours = scores.first { $0.teamId == teamId }?.score ?? 0
            let theirs = scores.first { $0.teamId == opponentId }?.score ?? 0
            // The name column takes the slack so the two scores line up on the right edge, the way
            // a scoreboard does. `firstTextBaseline` keeps the name sitting on the score's baseline
            // rather than floating against the larger type.
            Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 12, verticalSpacing: 2) {
                GridRow {
                    Text(snapshot.teamName(teamId))
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text(String(Int(ours)))
                        .font(.title.weight(.semibold))
                        .monospacedDigit()
                        .gridColumnAlignment(.trailing)
                }
                .fontWeight(ours >= theirs ? .semibold : .regular)
                GridRow {
                    Text(snapshot.teamName(opponentId))
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text(String(Int(theirs)))
                        .font(.title.weight(.semibold))
                        .monospacedDigit()
                        .gridColumnAlignment(.trailing)
                }
                .fontWeight(theirs > ours ? .semibold : .regular)
            }
            .frame(maxWidth: .infinity)
            .accessibilityElement(children: .combine)
            .accessibilityLabel(
                "\(snapshot.teamName(teamId)) \(Int(ours)), \(snapshot.teamName(opponentId)) \(Int(theirs))"
            )
        } else {
            // The tournament publishes that a game is happening but not the score. Say exactly that.
            Text("vs \(snapshot.teamName(opponentId))")
                .font(.title2.weight(.semibold))
            Text("Game in progress")
                .foregroundStyle(.secondary)
        }
    }
}

struct DetailLine: View {
    let items: [String?]

    var body: some View {
        let present = items.compactMap { $0 }.filter { !$0.isEmpty }
        if !present.isEmpty {
            // A wrapping row rather than a single joined string, so Dynamic Type at accessibility
            // sizes reflows instead of truncating.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 14) {
                    ForEach(present, id: \.self) { Text($0) }
                }
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(present, id: \.self) { Text($0) }
                }
            }
            .font(.subheadline)
            .foregroundStyle(.secondary)
        }
    }
}

struct PlacementRow: View {
    let title: String
    let subtitle: String
    let rank: Int
    let of: Int

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                Text(subtitle).font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 12)
            Text("\(rank)")
                .fontWeight(.semibold)
                .monospacedDigit()
            + Text(" of \(of)").foregroundStyle(.secondary)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 11)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(title), \(subtitle): \(rank) of \(of)")
    }
}

struct ResultRow: View {
    let result: QBLiveResult
    let snapshot: QBLiveSnapshot
    let teamId: String

    var body: some View {
        let ours = result.scores.first { $0.teamId == teamId }?.score ?? 0
        let theirs = result.scores.first { $0.teamId != teamId }
        let opponentId = theirs?.teamId
        let won = ours > (theirs?.score ?? 0)
        HStack {
            VStack(alignment: .leading, spacing: 1) {
                Text(snapshot.teamName(opponentId))
                Text(snapshot.schedule.first { $0.id == result.gameId }?.roundName ?? "")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 12)
            Text(won ? "W" : "L").fontWeight(.semibold)
            Text("\(Int(ours))–\(Int(theirs?.score ?? 0))")
                .foregroundStyle(.secondary)
                .monospacedDigit()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 11)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            "\(won ? "Won" : "Lost") against \(snapshot.teamName(opponentId)), \(Int(ours)) to \(Int(theirs?.score ?? 0))"
        )
    }
}

struct SectionHeader: View {
    let title: String

    init(_ title: String) { self.title = title }

    var body: some View {
        Text(title)
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
            .textCase(.uppercase)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Time formatting.
///
/// In the tournament's own zone, because the reader is usually standing in it, and with the
/// device's own 12/24-hour preference because that is what the system decides.
public enum LiveFormat {
    public static func time(_ date: Date, in zone: TimeZone) -> String {
        let formatter = DateFormatter()
        formatter.timeZone = zone
        formatter.locale = .autoupdatingCurrent
        formatter.setLocalizedDateFormatFromTemplate("jmm")
        return formatter.string(from: date)
    }

    public static func day(_ date: Date, in zone: TimeZone) -> String {
        let formatter = DateFormatter()
        formatter.timeZone = zone
        formatter.locale = .autoupdatingCurrent
        formatter.setLocalizedDateFormatFromTemplate("EEEMMMd")
        return formatter.string(from: date)
    }
}
