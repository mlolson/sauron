import Foundation
import os

/// Atomic, debounced JSON persistence for the app's state files.
public actor Persistence {
    private static let logger = Logger(subsystem: "com.mattolson.sauron", category: "persistence")

    public let paths: AppPaths
    private let debounceInterval: Duration
    private var pendingConfig: AppConfig?
    private var flushTask: Task<Void, Never>?

    public init(paths: AppPaths, debounceInterval: Duration = .milliseconds(250)) {
        self.paths = paths
        self.debounceInterval = debounceInterval
    }

    // MARK: Config

    public func loadConfig() throws -> AppConfig {
        try paths.createLayout()
        let url = paths.configFile
        guard FileManager.default.fileExists(atPath: url.path) else {
            return AppConfig()
        }
        let data = try Data(contentsOf: url)
        let config = try Self.decoder.decode(AppConfig.self, from: data)
        guard config.version <= AppConfig.currentVersion else {
            throw SauronError.persistence("config.json version \(config.version) is newer than this app supports (\(AppConfig.currentVersion)).")
        }
        return config
    }

    /// Schedules a write; consecutive calls within the debounce window collapse into one.
    public func saveConfig(_ config: AppConfig) {
        pendingConfig = config
        flushTask?.cancel()
        flushTask = Task { [debounceInterval] in
            do {
                try await Task.sleep(for: debounceInterval)
            } catch {
                return // cancelled by a newer save
            }
            await self.flush()
        }
    }

    /// Writes any pending config immediately.
    public func flush() async {
        guard let config = pendingConfig else { return }
        pendingConfig = nil
        do {
            try Self.write(config, to: paths.configFile)
        } catch {
            Self.logger.error("failed to write config: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Synchronous write used by flush and tests.
    public static func write<T: Encodable>(_ value: T, to url: URL) throws {
        let data = try encoder.encode(value)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url, options: .atomic)
    }

    public static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.prettyPrinted, .sortedKeys]
        e.dateEncodingStrategy = .iso8601
        return e
    }()

    public static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }()
}
