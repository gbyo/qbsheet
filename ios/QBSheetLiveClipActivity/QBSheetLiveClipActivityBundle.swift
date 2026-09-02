import SwiftUI
import WidgetKit

/// The App Clip's Live Activity extension.
///
/// Deliberately a separate target from the full app's, and deliberately not a separate
/// implementation: it compiles the same `QBSheetLiveActivityView.swift`. An App Clip cannot host
/// the containing app's extensions, so the target has to exist; there is no reason for its contents
/// to differ, and every reason for them not to.
///
/// This target's size counts against the App Clip's 15 MB budget, which is another reason the view
/// is stock SwiftUI with no assets of its own.
@main
struct QBSheetLiveClipActivityBundle: WidgetBundle {
    var body: some Widget {
        QBSheetLiveActivityView()
    }
}
