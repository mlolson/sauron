// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "Sauron",
    platforms: [.macOS(.v15)],
    products: [
        .executable(name: "Sauron", targets: ["Sauron"]),
        .library(name: "SauronCore", targets: ["SauronCore"]),
    ],
    targets: [
        .target(
            name: "SauronCore",
            path: "Sources/SauronCore"
        ),
        .executableTarget(
            name: "Sauron",
            dependencies: ["SauronCore"],
            path: "Sources/Sauron"
        ),
        .testTarget(
            name: "SauronCoreTests",
            dependencies: ["SauronCore"],
            path: "Tests/SauronCoreTests"
        ),
    ],
    swiftLanguageModes: [.v5]
)
