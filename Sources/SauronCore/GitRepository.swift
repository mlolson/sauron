import Foundation

public enum GitRepository {
    /// Path to git. Slice 2 replaces this with CLIResolver; the Xcode CLT git is always present when Sauron builds.
    public static var gitExecutable = "/usr/bin/git"

    /// Returns the repository root containing `directory`, or throws `notAGitRepository`.
    public static func toplevel(of directory: URL) async throws -> URL {
        let result = try await ExternalCommand.run(
            gitExecutable,
            arguments: ["rev-parse", "--show-toplevel"],
            currentDirectory: directory
        )
        guard result.exitCode == 0 else {
            throw SauronError.notAGitRepository(directory.path)
        }
        let path = result.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !path.isEmpty else { throw SauronError.notAGitRepository(directory.path) }
        return URL(fileURLWithPath: path, isDirectory: true).standardizedFileURL
    }
}
