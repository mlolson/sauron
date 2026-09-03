import Foundation
import os

public struct CommandResult: Sendable {
    public let stdout: String
    public let stderr: String
    public let exitCode: Int32
}

/// Runs an external executable asynchronously, capturing output.
///
/// Output goes to temporary files rather than pipes. A pipe would never reach end-of-file
/// if the command leaves a daemon behind that inherits it, which is exactly what
/// `tmux new-session` does when it starts a fresh server.
public enum ExternalCommand {
    private static let logger = Logger(subsystem: "com.mattolson.sauron", category: "command")

    /// Runs the command and returns its result regardless of exit status.
    public static func run(
        _ executable: String,
        arguments: [String] = [],
        currentDirectory: URL? = nil,
        environment: [String: String]? = nil
    ) async throws -> CommandResult {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        if let currentDirectory { process.currentDirectoryURL = currentDirectory }
        if let environment { process.environment = environment }

        let stdoutFile = try OutputCapture()
        let stderrFile = try OutputCapture()
        process.standardOutput = stdoutFile.handle
        process.standardError = stderrFile.handle
        process.standardInput = FileHandle.nullDevice

        logger.debug("run \(executable, privacy: .public) \(arguments.joined(separator: " "), privacy: .public)")

        let exitCode: Int32 = try await withCheckedThrowingContinuation { continuation in
            process.terminationHandler = { proc in
                continuation.resume(returning: proc.terminationStatus)
            }
            do {
                try process.run()
            } catch {
                continuation.resume(throwing: error)
            }
        }
        return CommandResult(stdout: stdoutFile.finish(), stderr: stderrFile.finish(), exitCode: exitCode)
    }

    /// Runs the command and throws `SauronError.commandFailed` on a non-zero exit.
    @discardableResult
    public static func check(
        _ executable: String,
        arguments: [String] = [],
        currentDirectory: URL? = nil,
        environment: [String: String]? = nil
    ) async throws -> String {
        let result = try await run(executable, arguments: arguments, currentDirectory: currentDirectory, environment: environment)
        guard result.exitCode == 0 else {
            let name = ([executable] + arguments).joined(separator: " ")
            logger.error("\(name, privacy: .public) failed: \(result.stderr, privacy: .public)")
            throw SauronError.commandFailed(command: name, exitCode: result.exitCode, stderr: result.stderr)
        }
        return result.stdout
    }
}

/// A temporary file that collects one output stream of a process.
private final class OutputCapture {
    let url: URL
    let handle: FileHandle

    init() throws {
        url = FileManager.default.temporaryDirectory
            .appendingPathComponent("sauron-cmd-\(UUID().uuidString)")
        guard FileManager.default.createFile(atPath: url.path, contents: nil) else {
            throw SauronError.persistence("could not create temporary file for command output")
        }
        handle = try FileHandle(forWritingTo: url)
    }

    /// Closes the write handle, reads the captured text, and deletes the file.
    func finish() -> String {
        try? handle.close()
        let data = (try? Data(contentsOf: url)) ?? Data()
        try? FileManager.default.removeItem(at: url)
        return String(decoding: data, as: UTF8.self)
    }
}
