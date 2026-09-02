import SwiftUI
import WidgetKit

/// The full app's Live Activity extension.
///
/// The App Clip has its own extension target with the same sources: an App Clip cannot use the
/// containing app's extensions, so the widget has to be built into both. The *code* is shared —
/// this file and `QBSheetLiveActivityView.swift` are compiled into each — which is what keeps the
/// two Lock Screens identical.
@main
struct QBSheetLiveActivityBundle: WidgetBundle {
    var body: some Widget {
        QBSheetLiveActivityView()
    }
}
