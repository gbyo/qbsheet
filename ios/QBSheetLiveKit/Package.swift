// swift-tools-version: 6.0
import PackageDescription

/// The code shared by QBSheet Live, its App Clip, and both Live Activity extensions.
///
/// # Why a package rather than a shared target group
///
/// The App Clip has a 15 MB thinned budget because it is invoked from printed QR codes, and the
/// surest way to blow a budget like that is to have two copies of the networking layer that drift
/// until somebody "just adds" a dependency to one of them. One package, imported by every target,
/// makes the shared surface explicit and makes its size measurable in one place.
///
/// # Dependencies
///
/// None, and that is a requirement rather than an accident. Everything here is Foundation, SwiftUI,
/// ActivityKit and WidgetKit. See `docs/QBLIVE_IOS.md`.
let package = Package(
    name: "QBSheetLiveKit",
    platforms: [.iOS(.v18)],
    products: [
        .library(name: "QBSheetLiveKit", targets: ["QBSheetLiveKit"])
    ],
    targets: [
        .target(
            name: "QBSheetLiveKit",
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .testTarget(
            name: "QBSheetLiveKitTests",
            dependencies: ["QBSheetLiveKit"],
            // The language-neutral QBLive fixtures, shared with the TypeScript and Worker suites.
            // Reading the same bytes is what keeps the three implementations from drifting.
            resources: [.copy("Fixtures")],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
    ]
)
