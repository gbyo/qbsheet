import SwiftUI

/// The whole QBSheet Live interface, shared by the full app and the App Clip.
///
/// One view hierarchy rather than two. The App Clip differs from the full app in exactly one
/// visible way — the upgrade banner — and duplicating five tabs to add a banner would be five
/// screens that drift.
///
/// Everything here is stock SwiftUI, SF Symbols and system typography. No design system, no
/// third-party components: the App Clip has a 15 MB thinned budget, and this is what stays inside it.
public struct LiveRootView: View {
    public enum Presentation: Sendable {
        case fullApp
        /// The App Clip. Shows an unobtrusive invitation to install the full app.
        case appClip
    }

    @State private var store: TournamentStore
    @State private var tab: Tab = .home
    @State private var choosingPlayer = false
    @Environment(\.scenePhase) private var scenePhase

    private let presentation: Presentation
    private let bootstrap: QBLiveBootstrap?

    public init(
        bootstrap: QBLiveBootstrap?,
        presentation: Presentation = .fullApp,
        store: TournamentStore = TournamentStore(),
        initialTab: String? = nil
    ) {
        self.bootstrap = bootstrap
        self.presentation = presentation
        _store = State(initialValue: store)
        _tab = State(initialValue: Tab(name: initialTab) ?? .home)
    }

    enum Tab: Hashable {
        case home, schedule, standings, stats, updates

        /// Only used by the debug launch argument that drives screenshots.
        init?(name: String?) {
            switch name {
            case "home": self = .home
            case "schedule": self = .schedule
            case "standings": self = .standings
            case "stats": self = .stats
            case "updates": self = .updates
            default: return nil
            }
        }
    }

    public var body: some View {
        Group {
            if let snapshot = store.snapshot {
                if let teamId = store.followedTeamId {
                    if choosingPlayer && snapshot.publishesPlayers {
                        SelectPlayerView(snapshot: snapshot, teamId: teamId) { playerId in
                            store.selectedPlayerId = playerId
                            choosingPlayer = false
                        }
                    } else {
                        tabs(snapshot: snapshot, teamId: teamId)
                    }
                } else {
                    FollowTeamView(snapshot: snapshot) { teamId in
                        store.followedTeamId = teamId
                        choosingPlayer = snapshot.publishesPlayers
                    }
                }
            } else if case .failed(let message) = store.connection {
                ProblemView(title: "This link did not open a tournament", detail: message)
            } else {
                LoadingView()
            }
        }
        .task {
            guard let bootstrap else { return }
            await store.open(bootstrap)
        }
        .onChange(of: scenePhase) { _, phase in
            // Coming back to the app should show current data, and going away should stop the
            // networking: background updates are the Live Activity's job, not a poll loop's.
            switch phase {
            case .active: Task { await store.refresh() }
            case .background: store.close()
            default: break
            }
        }
    }

    @ViewBuilder
    private func tabs(snapshot: QBLiveSnapshot, teamId: String) -> some View {
        TabView(selection: $tab) {
            navigation("Home") {
                HomeView(snapshot: snapshot, teamId: teamId, selectedPlayerId: store.selectedPlayerId)
            }
            .tabItem { Label("Home", systemImage: "house") }
            .tag(Tab.home)

            navigation("Schedule") {
                ScheduleView(snapshot: snapshot, teamId: teamId)
            }
            .tabItem { Label("Schedule", systemImage: "calendar") }
            .tag(Tab.schedule)

            navigation("Standings") {
                TablesView(tables: snapshot.standings, followedTeamId: teamId, selectedPlayerId: nil)
            }
            .tabItem { Label("Standings", systemImage: "list.number") }
            .tag(Tab.standings)

            navigation("Stats") {
                TablesView(
                    tables: snapshot.statistics,
                    followedTeamId: teamId,
                    selectedPlayerId: store.selectedPlayerId
                )
            }
            .tabItem { Label("Stats", systemImage: "chart.bar") }
            .tag(Tab.stats)

            navigation("Updates") {
                UpdatesView(snapshot: snapshot, teamId: teamId)
            }
            .tabItem { Label("Updates", systemImage: "bell") }
            .tag(Tab.updates)
        }
    }

    @ViewBuilder
    private func navigation(_ title: String, @ViewBuilder content: () -> some View) -> some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    StaleBanner(connection: store.connection, receivedAt: store.receivedAt)
                    if presentation == .appClip {
                        AppClipBanner()
                    }
                    content()
                }
                .padding(.horizontal)
                .padding(.bottom, 24)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .refreshable { await store.refresh() }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    ConnectionBadge(connection: store.connection)
                }
            }
        }
    }
}

/// Says how old the data is whenever it is not arriving live. Never lets cached data look current.
struct StaleBanner: View {
    let connection: TournamentStore.Connection
    let receivedAt: Date?

    var body: some View {
        if case .offline = connection {
            HStack(spacing: 8) {
                Image(systemName: "wifi.exclamationmark")
                    .foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(ageDescription)
                    Text("Reconnecting…")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            .font(.subheadline)
            .padding(12)
            .background(.quaternary, in: RoundedRectangle(cornerRadius: 10))
            .accessibilityElement(children: .combine)
        }
    }

    private var ageDescription: String {
        guard let receivedAt else { return "Not updated yet" }
        let seconds = Int(Date().timeIntervalSince(receivedAt))
        if seconds < 10 { return "Updated just now" }
        if seconds < 60 { return "Updated \(seconds) seconds ago" }
        let minutes = seconds / 60
        if minutes < 60 { return "Last updated \(minutes) \(minutes == 1 ? "minute" : "minutes") ago" }
        let hours = minutes / 60
        return "Last updated \(hours) \(hours == 1 ? "hour" : "hours") ago"
    }
}

struct ConnectionBadge: View {
    let connection: TournamentStore.Connection

    var body: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(color)
                .frame(width: 7, height: 7)
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Connection: \(label)")
    }

    private var color: Color {
        switch connection {
        case .live: .green
        case .polling: .secondary
        case .offline, .failed: .red
        case .loading: .secondary
        }
    }

    private var label: String {
        switch connection {
        case .live: "Live"
        case .polling: "Updated"
        case .offline: "Offline"
        case .failed: "Unavailable"
        case .loading: "Loading"
        }
    }
}

/// The App Clip's one difference from the full app.
struct AppClipBanner: View {
    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "arrow.down.app")
                .foregroundStyle(.tint)
            VStack(alignment: .leading, spacing: 2) {
                Text("QBSheet Live")
                    .font(.subheadline.weight(.semibold))
                Text("Get the app to keep this tournament on your Lock Screen.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 10))
        .accessibilityElement(children: .combine)
    }
}

struct LoadingView: View {
    var body: some View {
        VStack(spacing: 12) {
            ProgressView()
            Text("Loading the tournament…")
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

public struct ProblemView: View {
    let title: String
    let detail: String

    public init(title: String, detail: String) {
        self.title = title
        self.detail = detail
    }

    public var body: some View {
        ContentUnavailableView {
            Label(title, systemImage: "exclamationmark.triangle")
        } description: {
            Text(detail)
        }
    }
}
