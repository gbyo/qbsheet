import SwiftUI

/// Full-app hooks for the Live Activity coordinator.
///
/// The shared view does not own ActivityKit. The full app supplies these actions; the App Clip
/// supplies nothing, so it cannot accidentally acquire the full app's Lock Screen control.
public struct LiveActivityControls: Sendable {
    public let isRunning: Bool
    public let activePublicationId: String?
    public let activeTeamId: String?
    public let explanation: String?

    private let startAction: @MainActor @Sendable (QBLiveSnapshot, String) async -> Void
    private let updateAction: @MainActor @Sendable (QBLiveSnapshot, String) async -> Void
    private let endAction: @MainActor @Sendable (String) async -> Void

    public init(
        isRunning: Bool,
        activePublicationId: String?,
        activeTeamId: String?,
        explanation: String?,
        start: @escaping @MainActor @Sendable (QBLiveSnapshot, String) async -> Void,
        update: @escaping @MainActor @Sendable (QBLiveSnapshot, String) async -> Void,
        end: @escaping @MainActor @Sendable (String) async -> Void
    ) {
        self.isRunning = isRunning
        self.activePublicationId = activePublicationId
        self.activeTeamId = activeTeamId
        self.explanation = explanation
        self.startAction = start
        self.updateAction = update
        self.endAction = end
    }

    @MainActor
    func start(snapshot: QBLiveSnapshot, teamId: String) async {
        await startAction(snapshot, teamId)
    }

    @MainActor
    func update(snapshot: QBLiveSnapshot, teamId: String) async {
        await updateAction(snapshot, teamId)
    }

    @MainActor
    func end(publicationId: String) async {
        await endAction(publicationId)
    }
}

private struct LiveActivitySyncStamp: Equatable {
    let publicationId: String?
    let revision: Int?
    let final: Bool
    let tournamentStatus: String?
    let followedTeamId: String?

    init(snapshot: QBLiveSnapshot?, followedTeamId: String?) {
        self.publicationId = snapshot?.publicationId
        self.revision = snapshot?.revision
        self.final = snapshot?.final ?? false
        self.tournamentStatus = snapshot?.tournament.status.rawValue
        self.followedTeamId = followedTeamId
    }
}

/// The whole QBSheet Live interface, shared by the full app and the App Clip.
///
/// One view hierarchy rather than two. The App Clip differs from the full app in exactly one
/// visible way — the upgrade banner — and duplicating five tabs to add a banner would be five
/// screens that drift.
///
/// Everything here is stock SwiftUI, SF Symbols and system typography. No design system, no
/// third-party components: the App Clip has a 15 MB thinned budget, and this is what stays inside it.
public struct LiveRootView: View {
    public enum Presentation: Sendable, Equatable {
        case fullApp
        /// The App Clip. Shows an unobtrusive invitation to install the full app.
        case appClip
    }

    @State private var store: TournamentStore
    @State private var tab: Tab = .home
    @State private var choosingPlayer = false
    @State private var restartActivityAfterTeamChange = false
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.liveActivityController) private var activityController
    @State private var activityDriver = LiveActivityDriver()

    private let presentation: Presentation
    private let bootstrap: QBLiveBootstrap?
    private let liveActivityControls: LiveActivityControls?

    public init(
        bootstrap: QBLiveBootstrap?,
        presentation: Presentation = .fullApp,
        store: TournamentStore = TournamentStore(),
        initialTab: String? = nil,
        liveActivityControls: LiveActivityControls? = nil
    ) {
        self.bootstrap = bootstrap
        self.presentation = presentation
        self.liveActivityControls = liveActivityControls
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
                        follow(teamId: teamId, snapshot: snapshot)
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
        .onChange(
            of: LiveActivitySyncStamp(snapshot: store.snapshot, followedTeamId: store.followedTeamId)
        ) { _, _ in
            synchronizeLiveActivity()
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
        .onChange(of: store.snapshot?.revision) { reconcileActivity() }
        .onChange(of: store.snapshot?.publicationId) { reconcileActivity() }
        .onChange(of: store.followedTeamId) { reconcileActivity() }
    }

    /// Keep the Lock Screen activity in step with the followed team. Full app only: the App Clip
    /// never sets `liveActivityController`, and the presentation check keeps it that way even if
    /// that changes, so fixing the full app cannot light up activities in the Clip.
    private func reconcileActivity() {
        guard presentation == .fullApp, let activityController else { return }
        let snapshot = store.snapshot
        let teamId = store.followedTeamId
        Task { @MainActor in
            await activityDriver.reconcile(
                snapshot: snapshot, followedTeamId: teamId, controller: activityController)
        }
    }

    @ViewBuilder
    private func tabs(snapshot: QBLiveSnapshot, teamId: String) -> some View {
        TabView(selection: $tab) {
            navigation("Home") {
                HomeView(
                    snapshot: snapshot,
                    teamId: teamId,
                    selectedPlayerId: store.selectedPlayerId,
                    lockScreenControl: lockScreenControl(snapshot: snapshot, teamId: teamId)
                )
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
            // These are root destinations. Let NavigationStack use the platform's large-title
            // behavior and collapse it naturally as the spectator scrolls.
            .refreshable { await store.refresh() }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    if let snapshot = store.snapshot, let teamId = store.followedTeamId {
                        Menu {
                            Section(snapshot.teamName(teamId)) {
                                Button {
                                    changeTeam(snapshot: snapshot)
                                } label: {
                                    Label("Change Team", systemImage: "person.2")
                                }

                                if snapshot.publishesPlayers {
                                    Button {
                                        choosingPlayer = true
                                    } label: {
                                        Label(
                                            store.selectedPlayerId == nil ? "Choose Player" : "Change Player",
                                            systemImage: "person.crop.circle"
                                        )
                                    }
                                }
                            }
                        } label: {
                            Label("Following \(snapshot.teamName(teamId))", systemImage: "person.crop.circle")
                        }
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    if let bootstrap, let snapshot = store.snapshot {
                        ShareLink(
                            item: bootstrap.url(),
                            subject: Text(snapshot.tournament.name),
                            message: Text("Follow \(snapshot.tournament.name) in QBSheet Live.")
                        ) {
                            Label("Share Tournament", systemImage: "square.and.arrow.up")
                        }
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    ConnectionBadge(connection: store.connection)
                }
            }
        }
    }

    private func lockScreenControl(snapshot: QBLiveSnapshot, teamId: String) -> LockScreenControl? {
        guard presentation == .fullApp, let controls = liveActivityControls else { return nil }
        guard controls.isRunning || (!snapshot.final && snapshot.tournament.status != .complete) else {
            return nil
        }
        let capabilityExplanation = snapshot.capabilities.applePush
            ? nil
            : "This tournament has not turned on Lock Screen updates."
        return LockScreenControl(
            isRunning: controls.isRunning,
            explanation: controls.explanation ?? capabilityExplanation,
            toggle: {
                Task { @MainActor in
                    if controls.isRunning {
                        restartActivityAfterTeamChange = false
                        await controls.end(
                            publicationId: controls.activePublicationId ?? snapshot.publicationId
                        )
                    } else {
                        await controls.start(snapshot: snapshot, teamId: teamId)
                    }
                }
            }
        )
    }

    private func synchronizeLiveActivity() {
        guard let controls = liveActivityControls, controls.isRunning else { return }
        guard let snapshot = store.snapshot,
              let teamId = store.followedTeamId,
              controls.activePublicationId == snapshot.publicationId,
              controls.activeTeamId == teamId,
              !snapshot.final,
              snapshot.tournament.status != .complete
        else {
            if let publicationId = controls.activePublicationId {
                Task { @MainActor in await controls.end(publicationId: publicationId) }
            }
            return
        }
        Task { @MainActor in await controls.update(snapshot: snapshot, teamId: teamId) }
    }

    private func changeTeam(snapshot: QBLiveSnapshot) {
        guard let controls = liveActivityControls, controls.isRunning else {
            clearTeamSelection()
            return
        }
        restartActivityAfterTeamChange = true
        Task { @MainActor in
            await controls.end(publicationId: controls.activePublicationId ?? snapshot.publicationId)
            clearTeamSelection()
        }
    }

    private func follow(teamId: String, snapshot: QBLiveSnapshot) {
        store.followedTeamId = teamId
        choosingPlayer = snapshot.publishesPlayers
        guard restartActivityAfterTeamChange, let controls = liveActivityControls else { return }
        restartActivityAfterTeamChange = false
        Task { @MainActor in await controls.start(snapshot: snapshot, teamId: teamId) }
    }

    private func clearTeamSelection() {
        store.selectedPlayerId = nil
        store.followedTeamId = nil
        choosingPlayer = false
        tab = .home
    }
}

/// Says how old the data is whenever it is not arriving live. Never lets cached data look current.
struct StaleBanner: View {
    let connection: TournamentStore.Connection
    let receivedAt: Date?

    var body: some View {
        if case .offline = connection {
            GroupBox {
                VStack(alignment: .leading, spacing: 2) {
                    if let receivedAt {
                        Text("Last updated \(receivedAt, style: .relative)")
                    } else {
                        Text("Not updated yet")
                    }
                    Text("Reconnecting…")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            } label: {
                Label("Offline", systemImage: "wifi.exclamationmark")
                    .foregroundStyle(.secondary)
            }
            .font(.subheadline)
            .accessibilityElement(children: .combine)
        }
    }
}

struct ConnectionBadge: View {
    let connection: TournamentStore.Connection

    var body: some View {
        Label(label, systemImage: symbol)
            .font(.caption)
            .foregroundStyle(.secondary)
            .accessibilityLabel("Connection: \(label)")
    }

    private var symbol: String {
        switch connection {
        case .live: "antenna.radiowaves.left.and.right"
        case .polling: "arrow.clockwise"
        case .offline: "wifi.slash"
        case .failed: "exclamationmark.triangle"
        case .loading: "hourglass"
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
        GroupBox {
            Text("Get the app to keep this tournament on your Lock Screen.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        } label: {
            Label("QBSheet Live", systemImage: "arrow.down.app")
                .foregroundStyle(.tint)
        }
        .accessibilityElement(children: .combine)
    }
}

struct LoadingView: View {
    var body: some View {
        ProgressView("Loading the tournament…")
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

/// The Live Activity controller, supplied by the full app and absent everywhere else.
///
/// An `any LiveActivityControlling` existential rather than the concrete coordinator: the views
/// live in QBSheetLiveKit while the coordinator lives in the app's Shared sources, which compile
/// into both the full app and the Clip. Only the full app sets a value; the default nil is what
/// keeps the App Clip from ever starting an activity.
/// Environment storage for the activity controller. A box because an `any
/// LiveActivityControlling` existential is not `Sendable`; every access happens on the main actor
/// through the view hierarchy, so sharing the reference is safe.
struct LiveActivityControllerBox: @unchecked Sendable {
    var controller: (any LiveActivityControlling)?
}

private struct LiveActivityControllerKey: EnvironmentKey {
    static let defaultValue = LiveActivityControllerBox(controller: nil)
}

public extension EnvironmentValues {
    var liveActivityController: (any LiveActivityControlling)? {
        get { self[LiveActivityControllerKey.self].controller }
        set { self[LiveActivityControllerKey.self].controller = newValue }
    }
}
