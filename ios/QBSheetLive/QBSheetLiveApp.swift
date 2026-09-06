import SwiftUI
import VisionKit
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
    @State private var scanningTournament = false
    @State private var scanError: String?

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
                    NoTournamentView(scanAction: canScan ? { scanningTournament = true } : nil)
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
            .sheet(isPresented: $scanningTournament) {
                NavigationStack {
                    TournamentCodeScanner { payload in
                        guard let url = URL(string: payload), (try? QBLiveBootstrap(url: url)) != nil else {
                            scanError = "That QR code is not a QBSheet Live tournament code."
                            return
                        }
                        bootstrap = LiveEntryPoint.resolve(url: url)
                        scanningTournament = false
                    }
                    .navigationTitle("Scan Tournament")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Cancel") { scanningTournament = false }
                        }
                    }
                    .alert("Code Not Recognized", isPresented: scanErrorPresented) {
                        Button("OK") { scanError = nil }
                    } message: {
                        Text(scanError ?? "")
                    }
                }
            }
            .environment(activities)
        }
    }

    private var canScan: Bool {
        DataScannerViewController.isSupported && DataScannerViewController.isAvailable
    }

    private var scanErrorPresented: Binding<Bool> {
        Binding(
            get: { scanError != nil },
            set: { if !$0 { scanError = nil } }
        )
    }
}

/// The system document-camera scanner, configured to recognize only QR codes.
///
/// VisionKit owns camera focus, zoom, guidance, highlighting, accessibility, and the permission
/// experience. QBSheet only receives the decoded string and runs it through the same bootstrap
/// validation as a universal link.
private struct TournamentCodeScanner: UIViewControllerRepresentable {
    let onCode: (String) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onCode: onCode)
    }

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced,
            recognizesMultipleItems: false,
            isHighFrameRateTrackingEnabled: false,
            isPinchToZoomEnabled: true,
            isGuidanceEnabled: true,
            isHighlightingEnabled: true
        )
        scanner.delegate = context.coordinator
        try? scanner.startScanning()
        return scanner
    }

    func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {
        if !scanner.isScanning {
            try? scanner.startScanning()
        }
    }

    static func dismantleUIViewController(_ scanner: DataScannerViewController, coordinator: Coordinator) {
        scanner.stopScanning()
    }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onCode: (String) -> Void
        private var lastPayload: String?

        init(onCode: @escaping (String) -> Void) {
            self.onCode = onCode
        }

        func dataScanner(
            _ dataScanner: DataScannerViewController,
            didAdd addedItems: [RecognizedItem],
            allItems: [RecognizedItem]
        ) {
            guard case .barcode(let barcode) = addedItems.first,
                  let payload = barcode.payloadStringValue,
                  payload != lastPayload
            else { return }

            lastPayload = payload
            onCode(payload)
        }
    }
}
