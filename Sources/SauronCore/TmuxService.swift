import Foundation

/// Thin wrapper over the tmux CLI. All Sauron sessions live in the user's default tmux server
/// so they can be attached from any terminal.
public struct TmuxService: Sendable {
    public static let sessionPrefix = "sauron-"

    public let tmuxPath: String
    public let environment: [String: String]

    public init(tmuxPath: String, environment: [String: String]) {
        self.tmuxPath = tmuxPath
        self.environment = environment
    }

    // MARK: Naming

    /// Builds a tmux session name: `sauron-<slug>-<short id>`. tmux forbids "." and ":" in names.
    public static func sessionName(slug: String, id: UUID) -> String {
        let cleaned = slug.lowercased().map { $0.isLetter || $0.isNumber ? $0 : "-" }
        let collapsed = String(cleaned).split(separator: "-", omittingEmptySubsequences: true).joined(separator: "-")
        let short = id.uuidString.prefix(8).lowercased()
        return "\(sessionPrefix)\(String(collapsed.prefix(24)))-\(short)"
    }

    // MARK: Argument builders (pure, unit-tested)

    public static func newSessionArguments(name: String, workingDir: String, environment: [String: String], command: [String]) -> [String] {
        var args = ["new-session", "-d", "-s", name, "-c", workingDir]
        for key in environment.keys.sorted() {
            args += ["-e", "\(key)=\(environment[key]!)"]
        }
        // tmux runs the command through the user's shell, so quote each word.
        args.append(command.map(shellQuote).joined(separator: " "))
        return args
    }

    public static func shellQuote(_ word: String) -> String {
        if word.isEmpty { return "''" }
        let safe = word.allSatisfy { $0.isLetter || $0.isNumber || "-_./=:@%+,".contains($0) }
        if safe { return word }
        return "'" + word.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    /// Exact-match session target. tmux accepts `=name` for some commands but every command
    /// accepts `=name:` (exact session, default window).
    public static func target(_ name: String) -> String { "=\(name):" }

    public static func attachArguments(name: String) -> [String] {
        ["attach-session", "-t", target(name)]
    }

    // MARK: Operations

    public func newSession(name: String, workingDir: String, sessionEnvironment: [String: String], command: [String]) async throws {
        let args = Self.newSessionArguments(name: name, workingDir: workingDir, environment: sessionEnvironment, command: command)
        try await run(args)
        // Per-session options so the embedded terminal is clean and the session outlives detaches.
        try await run(["set-option", "-t", Self.target(name), "status", "off"])
        try await run(["set-option", "-t", Self.target(name), "mouse", "on"])
        try await run(["set-option", "-t", Self.target(name), "destroy-unattached", "off"])
    }

    public func hasSession(_ name: String) async -> Bool {
        guard let result = try? await ExternalCommand.run(tmuxPath, arguments: ["has-session", "-t", Self.target(name)], environment: environment) else {
            return false
        }
        return result.exitCode == 0
    }

    /// Names of all sessions on the server. An absent server yields an empty list.
    public func listSessions() async throws -> [String] {
        let result = try await ExternalCommand.run(tmuxPath, arguments: ["list-sessions", "-F", "#{session_name}"], environment: environment)
        guard result.exitCode == 0 else {
            if result.stderr.contains("no server running") || result.stderr.contains("No such file") {
                return []
            }
            throw SauronError.commandFailed(command: "tmux list-sessions", exitCode: result.exitCode, stderr: result.stderr)
        }
        return result.stdout.split(separator: "\n").map(String.init)
    }

    public func listSauronSessions() async throws -> [String] {
        try await listSessions().filter { $0.hasPrefix(Self.sessionPrefix) }
    }

    /// Types literal text followed by Enter.
    public func sendText(_ text: String, to name: String) async throws {
        try await run(["send-keys", "-t", Self.target(name), "-l", text])
        try await run(["send-keys", "-t", Self.target(name), "Enter"])
    }

    public func sendInterrupt(to name: String) async throws {
        try await run(["send-keys", "-t", Self.target(name), "C-c"])
    }

    public func killSession(_ name: String) async throws {
        try await run(["kill-session", "-t", Self.target(name)])
    }

    /// The command line the terminal view runs to attach.
    public var attachExecutable: String { tmuxPath }

    @discardableResult
    private func run(_ arguments: [String]) async throws -> String {
        try await ExternalCommand.check(tmuxPath, arguments: arguments, environment: environment)
    }
}
