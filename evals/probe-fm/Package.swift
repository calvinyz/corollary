// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "probe-fm",
    platforms: [.macOS("26.4")],  // SystemLanguageModel.tokenCount(for:)
    targets: [
        .executableTarget(name: "probe-fm", path: "Sources/probe-fm")
    ]
)
