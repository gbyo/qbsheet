import SwiftUI

/// First launch: scan, pick a team, optionally pick a player, done.
///
/// No account, no email, no password, no profile, no role picker, no tutorial. Following a team is
/// personalization stored on this device. It authorizes nothing.
struct FollowTeamView: View {
    let snapshot: QBLiveSnapshot
    let onFollow: (String) -> Void

    @State private var query = ""

    var body: some View {
        NavigationStack {
            Group {
                if hasSearchQuery && matches.isEmpty {
                    ContentUnavailableView.search(text: query)
                } else {
                    List {
                        Section {
                            ForEach(matches) { team in
                                Button {
                                    onFollow(team.id)
                                } label: {
                                    LabeledContent {
                                        if let seed = team.seed {
                                            Text("Seed \(Int(seed))")
                                                .foregroundStyle(.secondary)
                                        }
                                    } label: {
                                        Text(team.name)
                                    }
                                    .contentShape(.rect)
                                }
                                // Keep selection rows visually neutral while retaining the native
                                // List hit target and pressed behavior.
                                .buttonStyle(.plain)
                            }
                        } header: {
                            Text("Teams")
                        } footer: {
                            Text("Follow a team to see its schedule, results, and updates.")
                        }
                    }
                }
            }
            .navigationTitle(snapshot.tournament.name)
            .navigationBarTitleDisplayMode(.large)
            // Only when there are enough teams for search to be worth the chrome.
            .modifier(SearchIfMany(count: snapshot.teams.count, query: $query))
        }
    }

    private var hasSearchQuery: Bool {
        !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var matches: [QBLiveTeam] {
        let sorted = snapshot.teams.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
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

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(snapshot.team(teamId)?.players ?? []) { player in
                        Button(player.name) { onSelect(player.id) }
                            .buttonStyle(.plain)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .contentShape(.rect)
                    }
                } header: {
                    Text(snapshot.teamName(teamId))
                } footer: {
                    Text("Optional. Choose a player to highlight their statistics.")
                }
            }
            .navigationTitle("Choose a Player")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Skip") { onSelect(nil) }
                }
            }
        }
    }
}
