import Foundation

/// A git repository the user is tracking in Sauron.
public struct Project: Codable, Identifiable, Hashable, Sendable {
    public var id: UUID
    public var name: String
    /// Absolute path to the repository root.
    public var path: String
    public var addedAt: Date
    public var pinned: Bool

    public init(id: UUID = UUID(), name: String, path: String, addedAt: Date = Date(), pinned: Bool = false) {
        self.id = id
        self.name = name
        self.path = path
        self.addedAt = addedAt
        self.pinned = pinned
    }

    public var url: URL { URL(fileURLWithPath: path) }
}

/// Top-level persisted configuration (config.json).
public struct AppConfig: Codable, Equatable, Sendable {
    public static let currentVersion = 1

    public var version: Int
    public var projects: [Project]

    public init(version: Int = AppConfig.currentVersion, projects: [Project] = []) {
        self.version = version
        self.projects = projects
    }
}
