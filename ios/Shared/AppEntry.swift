import SwiftUI
import QBSheetLiveKit

/// The launch path shared by the full app and the App Clip.
///
/// # Four ways in, one answer
///
/// A tournament can arrive as a universal link, an App Clip invocation, a notification tap, or
/// nothing at all — the app reopened from the Home Screen. The last two are the interesting ones:
/// an App Clip launched from a notification does not always carry the original invocation URL, and
/// a full app opened from the Home Screen has no URL by definition. Both fall back to the bootstrap
/// this device saved when it last opened a tournament, which is why `LivePersistence.lastBootstrap`
/// is written on every open.
///
/// See `docs/QBLIVE_IOS.md`.
@MainActor
public struct LiveEntryPoint {
    public static func resolve(url: URL?) -> QBLiveBootstrap? {
        #if DEBUG
        // A launch argument, for automated verification. `simctl openurl` puts a confirmation
        // dialog in front of a custom scheme that nothing can tap on a headless runner, and a
        // universal link needs a provisioned domain. This is the only remaining way to open a
        // tournament from a script. Debug-only, like the scheme.
        if let index = ProcessInfo.processInfo.arguments.firstIndex(of: "-qblive-bootstrap"),
           ProcessInfo.processInfo.arguments.indices.contains(index + 1),
           let argument = URL(string: ProcessInfo.processInfo.arguments[index + 1]),
           let parsed = bootstrap(from: argument)
        {
            LivePersistence.shared.lastBootstrap = parsed
            return parsed
        }
        #endif
        if let url, let bootstrap = bootstrap(from: url) {
            LivePersistence.shared.lastBootstrap = bootstrap
            return bootstrap
        }
        return LivePersistence.shared.lastBootstrap
    }

    /// Parse a bootstrap out of any URL the app was handed.
    ///
    /// In a Debug build this also accepts `qbsheetlive://t/<id>?b=<origin>`, which exists for one
    /// reason: a universal link only works once `live.qbsheet.com` serves the AASA file and the app
    /// is signed with the matching Team ID, and neither is true in a simulator or on a CI runner.
    /// Without this, the app cannot be exercised end to end before the domain exists.
    ///
    /// It is `#if DEBUG` so it cannot ship. A custom scheme is claimable by any app on the device;
    /// a universal link is not, which is exactly why the release build uses only the latter.
    private static func bootstrap(from url: URL) -> QBLiveBootstrap? {
        if let parsed = try? QBLiveBootstrap(url: url) { return parsed }
        #if DEBUG
        if url.scheme == "qbsheetlive", var components = URLComponents(url: url, resolvingAgainstBaseURL: false) {
            // `qbsheetlive://t/<id>` puts the first path segment in `host`. Rebuild it as the https
            // form so exactly the same parser and the same validation run.
            let path = "/\(components.host ?? "")\(components.path)"
            components.scheme = "https"
            components.host = QBLiveBootstrap.officialHost
            components.path = path
            if let rebuilt = components.url { return try? QBLiveBootstrap(url: rebuilt) }
        }
        #endif
        return nil
    }

    /// The bootstrap carried by an App Clip invocation.
    ///
    /// `NSUserActivity` for a `.browsingWeb` activity carries the invocation URL. An App Clip that
    /// was launched some other way — a notification, or the App Clip card being reopened — has no
    /// activity URL, and `resolve` falls back to the saved bootstrap.
    public static func resolve(activity: NSUserActivity) -> QBLiveBootstrap? {
        guard activity.activityType == NSUserActivityTypeBrowsingWeb else {
            return LivePersistence.shared.lastBootstrap
        }
        return resolve(url: activity.webpageURL)
    }
}

#if DEBUG
/// Launch arguments that put the app on a specific screen.
///
/// For automated verification only. A simulator has no way to tap, so a script that wants a
/// screenshot of the Standings tab has no way to get there; these arguments are how the CI
/// screenshot job and a developer checking a layout drive the app without a UI test harness.
///
/// `#if DEBUG`, and read exactly once at launch. Nothing here bypasses a privacy setting or a
/// server response: the tournament still has to publish the team for `-qblive-team` to select it.
public enum DebugLaunch {
    public static func apply(to persistence: LivePersistence = .shared) {
        let arguments = ProcessInfo.processInfo.arguments
        func value(_ name: String) -> String? {
            guard let index = arguments.firstIndex(of: name), arguments.indices.contains(index + 1) else {
                return nil
            }
            return arguments[index + 1]
        }
        if arguments.contains("-qblive-reset") {
            persistence.followedTeamId = nil
            persistence.selectedPlayerId = nil
        }
        if let team = value("-qblive-team") { persistence.followedTeamId = team }
        if let player = value("-qblive-player") { persistence.selectedPlayerId = player }
    }

    /// The tab to open on, for the same reason.
    public static var initialTab: String? {
        let arguments = ProcessInfo.processInfo.arguments
        guard let index = arguments.firstIndex(of: "-qblive-tab"), arguments.indices.contains(index + 1) else {
            return nil
        }
        return arguments[index + 1]
    }
}
#endif

/// Shown when the app is opened with no tournament to show.
public struct NoTournamentView: View {
    public init() {}

    public var body: some View {
        ContentUnavailableView {
            Label("No tournament yet", systemImage: "qrcode.viewfinder")
        } description: {
            Text("Scan the QBSheet Live code at your tournament, or open the link a tournament director shared.")
        }
    }
}
