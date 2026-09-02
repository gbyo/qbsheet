import SwiftUI
import QBSheetLiveKit

/// QBSheet Live, the full App Store application.
///
/// The App Clip must ship with a corresponding full app; this is it. It differs from the Clip in
/// three ways and no others: it can start a Live Activity, it can register for notifications, and
/// it does not show the install banner. Everything a spectator sees is `LiveRootView`, shared.
@main
struct QBSheetLiveApp: App {
    @State private var bootstrap: QBLiveBootstrap?
    @State private var activities = LiveActivityCoordinator()

    private var initialTab: String? {
        #if DEBUG
        DebugLaunch.initialTab
        #else
        nil
        #endif
    }

    var body: some Scene {
        WindowGroup {
            Group {
                if let bootstrap {
                    LiveRootView(bootstrap: bootstrap, presentation: .fullApp, initialTab: initialTab)
                } else {
                    NoTournamentView()
                }
            }
            .task {
                #if DEBUG
                DebugLaunch.apply()
                #endif
                // A cold launch from the Home Screen has no URL. Reopening the last tournament is
                // the right answer: a spectator who used the app this morning wants it back.
                bootstrap = LiveEntryPoint.resolve(url: nil)
            }
            .onOpenURL { url in
                bootstrap = LiveEntryPoint.resolve(url: url)
            }
            .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                bootstrap = LiveEntryPoint.resolve(activity: activity)
            }
            .environment(activities)
        }
    }
}
