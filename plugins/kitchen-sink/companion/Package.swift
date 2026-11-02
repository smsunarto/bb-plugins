// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "ClickyCompanion",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "ClickyBB", targets: ["ClickyMac"])],
    targets: [
        .target(name: "ClickyCore"),
        .executableTarget(name: "ClickyMac", dependencies: ["ClickyCore"],
            swiftSettings: [.defaultIsolation(MainActor.self), .enableUpcomingFeature("NonisolatedNonsendingByDefault")]),
        .testTarget(name: "ClickyCoreTests", dependencies: ["ClickyCore"])
    ]
)
