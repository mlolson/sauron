import Foundation
import os

public struct CommandResult: Sendable {
    public let stdout: String
    public let stderr: String
    public let exitCode: Int32
}

/// Runs an external executable asynchronously, capturing output.
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

        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe
        process.standardInput = FileHandle.nullDevice

        logger.debug("run \(executable, privacy: .public) \(arguments.joined(separator: " "), privacy: .public)")

        return try await withCheckedThrowingContinuation { continuation in
            process.terminationHandler = { proc in
                let out = String(decoding: stdoutPipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
                let err = String(decoding: stderrPipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
                continuation.resume(returning: CommandResult(stdout: out, stderr: err, exitCode: proc.terminationStatus))
            }
            do {
                try process.run()
            } catch {
                continuation.resume(throwing: error)
            }
        }
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
