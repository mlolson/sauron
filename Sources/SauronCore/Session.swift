import Foundation

public enum AgentTool: String, Codable, Sendable, CaseIterable {
    case claude
    case codex

    public var displayName: String {
        switch self {
        case .claude: return "Claude"
        case .codex: return "Codex"
        }
    }
}

public enum SessionKind: String, Codable, Sendable {
    /// Launched by Sauron inside tmux.
    case managed
    /// Discovered from transcripts; started outside Sauron.
    case external
}

public enum SessionState: String, Codable, Sendable {
    case running
    case waitingForInput
    case idle
    case stopped
}

public enum StateSource: String, Codable, Sendable {
    case hook
    case inferred
}

public struct Session: Codable, Identifiable, Hashable, Sendable {
    public var id: UUID
    /// nil for the master agent.
    public var projectId: UUID?
    public var tool: AgentTool
    public var kind: SessionKind
    public var displayName: String
    public var tmuxName: String?
    /// The Claude or Codex session id. For Claude it is chosen by Sauron at launch.
    public var cliSessionId: String?
    public var transcriptPath: String?
    public var workingDir: String
    public var worktreePath: String?
    public var createdAt: Date
    public var lastActivityAt: Date
    public var state: SessionState
    public var stateSource: StateSource

    public init(
        id: UUID = UUID(),
        projectId: UUID?,
        tool: AgentTool,
        kind: SessionKind,
        displayName: String,
        tmuxName: String? = nil,
        cliSessionId: String? = nil,
        transcriptPath: String? = nil,
        workingDir: String,
        worktreePath: String? = nil,
        createdAt: Date = Date(),
        lastActivityAt: Date = Date(),
        state: SessionState = .running,
        stateSource: StateSource = .inferred
    ) {
        self.id = id
        self.projectId = projectId
        self.tool = tool
        self.kind = kind
        self.displayName = displayName
        self.tmuxName = tmuxName
        self.cliSessionId = cliSessionId
        self.transcriptPath = transcriptPath
        self.workingDir = workingDir
        self.worktreePath = worktreePath
        self.createdAt = createdAt
        self.lastActivityAt = lastActivityAt
        self.state = state
        self.stateSource = stateSource
    }

    public var isAlive: Bool { state != .stopped }
}

/// Persisted sessions.json.
public struct SessionsFile: Codable, Equatable, Sendable {
    public static let currentVersion = 1
    public var version: Int
    public var sessions: [Session]

    public init(version: Int = SessionsFile.currentVersion, sessions: [Session] = []) {
        self.version = version
        self.sessions = sessions
    }
}

public enum ClaudeTranscripts {
    /// Claude Code stores transcripts under ~/.claude/projects/<encoded cwd>/<session id>.jsonl,
    /// where every character that is not a letter or digit is replaced by "-".
    public static func encodeProjectPath(_ path: String) -> String {
        String(path.map { $0.isLetter || $0.isNumber ? $0 : "-" })
    }

    public static func transcriptURL(cwd: String, sessionId: String, home: URL = FileManager.default.homeDirectoryForCurrentUser) -> URL {
        home.appendingPathComponent(".claude/projects", isDirectory: true)
            .appendingPathComponent(encodeProjectPath(cwd), isDirectory: true)
            .appendingPathComponent("\(sessionId).jsonl")
    }
}
