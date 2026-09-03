import Foundation
import os

/// Locations of the external tools Sauron drives.
public struct ToolPaths: Sendable, Equatable {
    public var claude: String?
    public var codex: String?
    public var tmux: String?
    public var git: String?
    /// The PATH used to find them; passed into launched sessions.
    public var path: String

    public init(claude: String? = nil, codex: String? = nil, tmux: String? = nil, git: String? = nil, path: String) {
        self.claude = claude
        self.codex = codex
        self.tmux = tmux
        self.git = git
        self.path = path
    }

    /// Tools without which Sauron cannot function.
    public var missingRequired: [String] {
        var missing: [String] = []
        if claude == nil { missing.append("claude") }
        if tmux == nil { missing.append("tmux") }
        if git == nil { missing.append("git") }
        return missing
    }
}

/// Resolves the user's real PATH and locates executables. GUI apps get a minimal environment,
/// so this asks the login shell.
public enum CLIResolver {
    private static let logger = Logger(subsystem: "com.mattolson.sauron", category: "cli")

    public static func loginShellPath() async -> String {
        let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
        let marker = "SAURON_PATH_MARKER"
        // -l loads the login profile; -i is deliberately omitted because interactive rc files
        // may print or block. zsh users typically set PATH in .zprofile or .zshenv, both of which run.
        do {
            let result = try await ExternalCommand.run(shell, arguments: ["-lc", "echo \(marker)$PATH"])
            if let line = result.stdout.split(separator: "\n").last(where: { $0.hasPrefix(marker) }) {
                let path = String(line.dropFirst(marker.count)).trimmingCharacters(in: .whitespaces)
                if !path.isEmpty { return path }
            }
            logger.warning("login shell did not report PATH; stderr: \(result.stderr, privacy: .public)")
        } catch {
            logger.error("login shell failed: \(error.localizedDescription, privacy: .public)")
        }
        let fallback = ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin"
        return fallback + ":/opt/homebrew/bin:/usr/local/bin:\(NSHomeDirectory())/.local/bin"
    }

    public static func find(_ name: String, in path: String) -> String? {
        for dir in path.split(separator: ":") {
            let candidate = URL(fileURLWithPath: String(dir)).appendingPathComponent(name).path
            if FileManager.default.isExecutableFile(atPath: candidate) {
                return candidate
            }
        }
        return nil
    }

    public static func resolve(overrides: [String: String] = [:]) async -> ToolPaths {
        let path = await loginShellPath()
        func locate(_ name: String) -> String? {
            if let override = overrides[name], !override.isEmpty { return override }
            return find(name, in: path)
        }
        let paths = ToolPaths(
            claude: locate("claude"),
            codex: locate("codex"),
            tmux: locate("tmux"),
            git: locate("git"),
            path: path
        )
        logger.info("resolved tools: claude=\(paths.claude ?? "nil", privacy: .public) codex=\(paths.codex ?? "nil", privacy: .public) tmux=\(paths.tmux ?? "nil", privacy: .public) git=\(paths.git ?? "nil", privacy: .public)")
        return paths
    }

    /// Environment for launched sessions: the current environment with PATH replaced and
    /// TERM set for a color terminal.
    public static func sessionEnvironment(path: String, extra: [String: String] = [:]) -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = path
        env["TERM"] = "xterm-256color"
        env["COLORTERM"] = "truecolor"
        env["LANG"] = env["LANG"] ?? "en_US.UTF-8"
        for (k, v) in extra { env[k] = v }
        return env
    }
}
