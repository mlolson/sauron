// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "Sauron",
    platforms: [.macOS(.v15)],
    products: [
        .executable(name: "Sauron", targets: ["Sauron"]),
        .library(name: "SauronCore", targets: ["SauronCore"]),
    ],
    dependencies: [
        .package(url: "https://github.com/migueldeicaza/SwiftTerm.git", from: "1.2.0"),
    ],
    targets: [
        .target(
            name: "SauronCore",
            path: "Sources/SauronCore"
        ),
        .executableTarget(
            name: "Sauron",
            dependencies: [
                "SauronCore",
                .product(name: "SwiftTerm", package: "SwiftTerm"),
            ],
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
