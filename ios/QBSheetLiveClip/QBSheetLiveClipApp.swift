import SwiftUI
import QBSheetLiveKit

/// QBSheet Live, the App Clip.
///
/// # The whole flow
///
/// ```
/// scan a printed code → App Clip card → Open → tournament loads → follow a team → Home
/// ```
///
/// No account, no email, no password, no profile, no role picker, no tutorial. The Clip's job is to
/// be the fastest possible path from a poster to "my team plays Greenwood A in Room 104".
///
/// # Size
///
/// Invoked from printed codes, so Apple's 15 MB thinned-uncompressed limit applies rather than the
/// 50 MB digital-invocation one. Everything here is `QBSheetLiveKit`, SwiftUI, and nothing else;
/// `ios/scripts/measure-app-clip.sh` fails the build if that stops being true. See
/// `docs/QBLIVE.md#12-app-clip-size`.
@main
struct QBSheetLiveClipApp: App {
    @State private var bootstrap: QBLiveBootstrap?

    var body: some Scene {
        WindowGroup {
            Group {
                if let bootstrap {
                    LiveRootView(bootstrap: bootstrap, presentation: .appClip)
                } else {
                    NoTournamentView()
                }
            }
            .task {
                // A Clip reopened by a notification tap carries no invocation URL. The saved
                // bootstrap is what makes that tap land on the right tournament rather than a
                // blank screen. See `docs/QBLIVE_IOS.md#app-clip-notifications`.
                bootstrap = LiveEntryPoint.resolve(url: nil)
            }
            .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                bootstrap = LiveEntryPoint.resolve(activity: activity)
            }
            .onOpenURL { url in
                bootstrap = LiveEntryPoint.resolve(url: url)
            }
        }
    }
}
