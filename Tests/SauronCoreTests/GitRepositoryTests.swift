import Foundation
import Testing
@testable import SauronCore

@Suite struct GitRepositoryTests {
    @Test func toplevelOfSubdirectory() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("SauronGit-\(UUID().uuidString)", isDirectory: true)
        let sub = root.appendingPathComponent("a/b", isDirectory: true)
        try FileManager.default.createDirectory(at: sub, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try await ExternalCommand.check("/usr/bin/git", arguments: ["init", "-q"], currentDirectory: root)

        let top = try await GitRepository.toplevel(of: sub)
        #expect(top.resolvingSymlinksInPath().path == root.standardizedFileURL.resolvingSymlinksInPath().path)
    }

    @Test func nonRepositoryThrows() async throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("SauronNotGit-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        await #expect(throws: SauronError.notAGitRepository(dir.path)) {
            _ = try await GitRepository.toplevel(of: dir)
        }
    }
}
