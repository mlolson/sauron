import Foundation

public enum SauronError: Error, LocalizedError, Equatable, Sendable {
    case notAGitRepository(String)
    case projectAlreadyAdded(String)
    case commandFailed(command: String, exitCode: Int32, stderr: String)
    case executableNotFound(String)
    case persistence(String)

    public var errorDescription: String? {
        switch self {
        case .notAGitRepository(let path):
            return "\(path) is not inside a git repository."
        case .projectAlreadyAdded(let path):
            return "\(path) is already in the project list."
        case .commandFailed(let command, let exitCode, let stderr):
            let detail = stderr.trimmingCharacters(in: .whitespacesAndNewlines)
            return "\(command) exited with status \(exitCode)" + (detail.isEmpty ? "" : ": \(detail)")
        case .executableNotFound(let name):
            return "Could not find \(name) on PATH."
        case .persistence(let message):
            return "Persistence error: \(message)"
        }
    }
}
