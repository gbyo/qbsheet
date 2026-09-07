import ActivityKit
import SwiftUI
import WidgetKit
import QBSheetLiveKit

/// The team Live Activity.
///
/// # What it shows, and what it deliberately does not
///
/// One team's current state: opponent, score if the tournament publishes one, room, and either the
/// stated scheduled time or nothing. No table, no standings, no schedule. A Lock Screen is read in
/// two seconds while walking down a corridor.
///
/// A broadcast channel delivers the same `ContentState` to every subscriber, so the view picks out
/// the followed team's entry using the `slot` recorded in the static attributes. That is what makes
/// one APNs channel serve a whole shard of teams and any number of viewers.
struct QBSheetLiveActivityView: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: QBLiveActivityAttributes.self) { context in
            LockScreenView(attributes: context.attributes, state: context.state)
                .padding(16)
                .activityBackgroundTint(nil)
                .activitySystemActionForegroundColor(nil)
        } dynamicIsland: { context in
            let team = context.state.team(slot: context.attributes.slot)
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Text(context.attributes.followedTeamName)
                        .font(.caption.weight(.semibold))
                        .lineLimit(1)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    if let team, let ours = team.s, let theirs = team.x {
                        Text("\(ours)–\(theirs)")
                            .font(.title3.weight(.semibold))
                            .monospacedDigit()
                    } else {
                        Text(statusWord(team))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    ExpandedActivityDetailView(
                        attributes: context.attributes,
                        state: context.state,
                        team: team
                    )
                }
            } compactLeading: {
                Image(systemName: "flag.checkered")
            } compactTrailing: {
                if let team, let ours = team.s, let theirs = team.x {
                    Text("\(ours)–\(theirs)").monospacedDigit()
                } else {
                    Text(shortStatus(team))
                }
            } minimal: {
                Image(systemName: "flag.checkered")
            }
            .keylineTint(.accentColor)
        }
    }

    private func statusWord(_ team: QBLiveActivityAttributes.TeamState?) -> String {
        switch team?.m {
        case .live: "In progress"
        case .final: "Final"
        case .upcoming: "Next"
        case .idle, nil: "—"
        }
    }

    private func shortStatus(_ team: QBLiveActivityAttributes.TeamState?) -> String {
        switch team?.m {
        case .live: "Live"
        case .final: "Final"
        case .upcoming: "Next"
        case .idle, nil: "—"
        }
    }
}

/// Uses the extra room in the expanded Dynamic Island for the context people actually need:
/// what the score/status is *for*. Compact and minimal presentations stay intentionally terse.
struct ExpandedActivityDetailView: View {
    let attributes: QBLiveActivityAttributes
    let state: QBLiveActivityAttributes.ContentState
    let team: QBLiveActivityAttributes.TeamState?

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if let headline {
                Text(headline)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
            }
            DetailRow(attributes: attributes, team: team)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var headline: String? {
        guard let team else { return nil }
        if let event = team.ev { return event }

        switch team.m {
        case .upcoming, .live, .final:
            let opponent = activityOpponentName(team, state: state)
            return opponent == "—" ? nil : "vs \(opponent)"
        case .idle:
            return nil
        }
    }
}

struct LockScreenView: View {
    let attributes: QBLiveActivityAttributes
    let state: QBLiveActivityAttributes.ContentState

    var body: some View {
        let team = state.team(slot: attributes.slot)
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(attributes.tournamentName)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Spacer(minLength: 8)
                if team?.m == .live {
                    Label("Live", systemImage: "dot.radiowaves.left.and.right")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.red)
                }
            }

            if let team, let ours = team.s, let theirs = team.x {
                Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 12, verticalSpacing: 1) {
                    GridRow {
                        Text(attributes.followedTeamName).lineLimit(1)
                        Text("\(ours)")
                            .font(.title2.weight(.semibold))
                            .monospacedDigit()
                            .gridColumnAlignment(.trailing)
                    }
                    .fontWeight(ours >= theirs ? .semibold : .regular)
                    GridRow {
                        Text(activityOpponentName(team, state: state)).lineLimit(1)
                        Text("\(theirs)")
                            .font(.title2.weight(.semibold))
                            .monospacedDigit()
                            .gridColumnAlignment(.trailing)
                    }
                    .fontWeight(theirs > ours ? .semibold : .regular)
                }
            } else if let team, team.m == .upcoming {
                Text(team.ev ?? "vs \(activityOpponentName(team, state: state))")
                    .font(.headline)
            } else if let team, team.m == .live {
                // The tournament publishes that a game is happening but not the score.
                Text("vs \(activityOpponentName(team, state: state))")
                    .font(.headline)
                Text("Game in progress")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                Text(attributes.followedTeamName)
                    .font(.headline)
                Text("Nothing scheduled")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            DetailRow(attributes: attributes, team: team)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

private func activityOpponentName(
    _ team: QBLiveActivityAttributes.TeamState,
    state: QBLiveActivityAttributes.ContentState
) -> String {
    // A same-shard opponent is an index into the broadcast state; a cross-shard opponent carries
    // its own name, because the shard does not contain it.
    if let name = team.on { return name }
    if let index = team.o, let opponent = state.t.first(where: { $0.i == index }) {
        return "Team \(opponent.i + 1)"
    }
    return "—"
}

struct DetailRow: View {
    let attributes: QBLiveActivityAttributes
    let team: QBLiveActivityAttributes.TeamState?

    var body: some View {
        let parts: [String] = [
            team?.rd.map { "Round \($0)" },
            team?.rm,
            team?.u.map { "TU \($0)" },
            // Only a stated scheduled time is ever shown. No estimates, ever.
            // See docs/QBLIVE.md#72-no-estimated-times.
            team?.scheduledStart.map { start in
                start.formatted(date: .omitted, time: .shortened)
            },
        ]
        .compactMap { $0 }

        if !parts.isEmpty {
            Text(parts.joined(separator: " · "))
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
    }
}
