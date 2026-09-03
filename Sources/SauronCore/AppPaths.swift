import Foundation

/// On-disk layout under ~/Library/Application Support/Sauron.
public struct AppPaths: Sendable {
    public let root: URL

    public init(root: URL) {
        self.root = root
    }

    public static func standard() -> AppPaths {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return AppPaths(root: base.appendingPathComponent("Sauron", isDirectory: true))
    }

    public var configFile: URL { root.appendingPathComponent("config.json") }
    public var sessionsFile: URL { root.appendingPathComponent("sessions.json") }
    public var statusDirectory: URL { root.appendingPathComponent("status", isDirectory: true) }
    public var masterDirectory: URL { root.appendingPathComponent("master", isDirectory: true) }
    public var sessionsDirectory: URL { root.appendingPathComponent("sessions", isDirectory: true) }
    public var worktreesDirectory: URL { root.appendingPathComponent("worktrees", isDirectory: true) }
    public var binDirectory: URL { root.appendingPathComponent("bin", isDirectory: true) }
    public var socketFile: URL { root.appendingPathComponent("sauron.sock") }

    /// Creates every directory in the layout. Idempotent.
    public func createLayout() throws {
        for dir in [root, statusDirectory, masterDirectory, sessionsDirectory, worktreesDirectory, binDirectory] {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        }
    }
}
