import SwiftUI

/// First launch: scan, pick a team, optionally pick a player, done.
///
/// No account, no email, no password, no profile, no role picker, no tutorial. Following a team is
/// personalization stored on this device. It authorizes nothing.
struct FollowTeamView: View {
    let snapshot: QBLiveSnapshot
    let onFollow: (String) -> Void

    @State private var query = ""
    @State private var selectionFeedback = 0

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(matches) { team in
                        Button {
                            selectionFeedback += 1
                            onFollow(team.id)
                        } label: {
                            HStack {
                                Text(team.name)
                                Spacer(minLength: 12)
                                if let seed = team.seed {
                                    Text("Seed \(Int(seed))")
                                        .font(.subheadline)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            .contentShape(.rect)
                        }
                        // `.plain` so a team reads as a name rather than as a link. The whole row
                        // is still the hit target, via `contentShape`.
                        .buttonStyle(.plain)
                    }
                } header: {
                    Text("Follow a team to see its schedule, results, and updates.")
                        .textCase(nil)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle(snapshot.tournament.name)
            .navigationBarTitleDisplayMode(.large)
            // Only when there are enough teams for search to be worth the chrome.
            .modifier(SearchIfMany(count: snapshot.teams.count, query: $query))
            .sensoryFeedback(.selection, trigger: selectionFeedback)
        }
    }

    private var matches: [QBLiveTeam] {
        let sorted = snapshot.teams.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        let needle = query.trimmingCharacters(in: .whitespaces)
        guard !needle.isEmpty else { return sorted }
        return sorted.filter { $0.name.localizedCaseInsensitiveContains(needle) }
    }
}

/// A twelve-team tournament does not need a search field taking up the top of the screen.
private struct SearchIfMany: ViewModifier {
    let count: Int
    @Binding var query: String

    func body(content: Content) -> some View {
        if count > 12 {
            content.searchable(text: $query, prompt: "Search teams")
        } else {
            content
        }
    }
}

/// Optional player selection.
///
/// Offered only when the tournament publishes rosters. Choosing a player highlights their rows and
/// shows their placement. It verifies nothing, unlocks nothing, and reveals nothing that was not
/// already public.
struct SelectPlayerView: View {
    let snapshot: QBLiveSnapshot
    let teamId: String
    let onSelect: (String?) -> Void

    @State private var selectionFeedback = 0

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(snapshot.team(teamId)?.players ?? []) { player in
                        Button(player.name) {
                            selectionFeedback += 1
                            onSelect(player.id)
                        }
                        .buttonStyle(.plain)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(.rect)
                    }
                } header: {
                    Text("Optional. Pick a player to highlight their statistics.")
                        .textCase(nil)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                Section {
                    Button("Not now") {
                        selectionFeedback += 1
                        onSelect(nil)
                    }
                }
            }
            .navigationTitle("Show my player stats")
            .navigationBarTitleDisplayMode(.inline)
            .sensoryFeedback(.selection, trigger: selectionFeedback)
        }
    }
}
