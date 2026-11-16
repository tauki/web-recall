// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "WebRecallApple",
  platforms: [.macOS("26.4")],
  products: [
    .executable(name: "web-recall-apple", targets: ["WebRecallApple"]),
    .executable(name: "WebRecallCompanion", targets: ["WebRecallCompanion"]),
    .executable(name: "WebRecallUpdater", targets: ["WebRecallUpdater"])
  ],
  targets: [
    .target(name: "NativeProtocol"),
    .target(name: "CompanionCore", dependencies: ["NativeProtocol"]),
    .target(name: "AppleInference", dependencies: ["NativeProtocol"]),
    .target(name: "UpdateCore"),
    .executableTarget(name: "WebRecallApple", dependencies: ["NativeProtocol", "CompanionCore"]),
    .executableTarget(name: "WebRecallCompanion", dependencies: ["NativeProtocol", "CompanionCore", "AppleInference", "UpdateCore"]),
    .executableTarget(name: "WebRecallUpdater", dependencies: ["UpdateCore"]),
    .testTarget(name: "NativeProtocolTests", dependencies: ["NativeProtocol"]),
    .testTarget(name: "CompanionCoreTests", dependencies: ["CompanionCore", "NativeProtocol"]),
    .testTarget(name: "AppleInferenceTests", dependencies: ["AppleInference", "NativeProtocol"]),
    .testTarget(name: "UpdateCoreTests", dependencies: ["UpdateCore"])
  ]
)
