// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "corollary-fm",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/ml-explore/mlx-swift-lm", exact: "3.32.3"),
        .package(url: "https://github.com/huggingface/swift-huggingface", exact: "0.13.0"),
        .package(url: "https://github.com/huggingface/swift-transformers", exact: "1.3.5"),
    ],
    targets: [
        .executableTarget(
            name: "corollary-fm",
            dependencies: [
                .product(name: "MLXVLM", package: "mlx-swift-lm"),
                .product(name: "MLXLMCommon", package: "mlx-swift-lm"),
                .product(name: "MLXHuggingFace", package: "mlx-swift-lm"),
                .product(name: "HuggingFace", package: "swift-huggingface"),
                .product(name: "Tokenizers", package: "swift-transformers"),
            ],
            swiftSettings: [.swiftLanguageMode(.v5)],
            // FoundationModels only exists on macOS 26+; the helper still serves OCR on older systems.
            // The app bundle ships Swift's back-deployment dylibs in Contents/Frameworks.
            linkerSettings: [.unsafeFlags([
                "-Xlinker", "-weak_framework", "-Xlinker", "FoundationModels",
                "-Xlinker", "-rpath", "-Xlinker", "@executable_path",
                "-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks",
            ])]
        ),
        .testTarget(name: "corollary-fm-tests", dependencies: ["corollary-fm"]),
    ]
)
