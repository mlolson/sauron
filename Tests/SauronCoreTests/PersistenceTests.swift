import Foundation
import Testing
@testable import SauronCore

private func temporaryPaths(_ prefix: String) -> AppPaths {
    let dir = FileManager.default.temporaryDirectory
        .appendingPathComponent("\(prefix)-\(UUID().uuidString)", isDirectory: true)
    return AppPaths(root: dir)
}

@Suite struct PersistenceTests {
    @Test func loadReturnsEmptyConfigWhenFileMissing() async throws {
        let paths = temporaryPaths("SauronTests")
        defer { try? FileManager.default.removeItem(at: paths.root) }
        let persistence = Persistence(paths: paths)
        let config = try await persistence.loadConfig()
        #expect(config == AppConfig())
        #expect(FileManager.default.fileExists(atPath: paths.statusDirectory.path))
    }

    @Test func configRoundTrips() async throws {
        let paths = temporaryPaths("SauronTests")
        defer { try? FileManager.default.removeItem(at: paths.root) }
        let persistence = Persistence(paths: paths, debounceInterval: .milliseconds(10))

        let project = Project(name: "sauron", path: "/Users/me/code/sauron", addedAt: Date(timeIntervalSince1970: 1_700_000_000), pinned: true)
        let config = AppConfig(projects: [project])
        await persistence.saveConfig(config)
        await persistence.flush()

        let loaded = try await persistence.loadConfig()
        #expect(loaded == config)
    }

    @Test func debounceCollapsesWrites() async throws {
        let paths = temporaryPaths("SauronTests")
        defer { try? FileManager.default.removeItem(at: paths.root) }
        let persistence = Persistence(paths: paths, debounceInterval: .milliseconds(50))

        await persistence.saveConfig(AppConfig(projects: [Project(name: "a", path: "/a")]))
        await persistence.saveConfig(AppConfig(projects: [Project(name: "b", path: "/b")]))
        try await Task.sleep(for: .milliseconds(150))

        let loaded = try await persistence.loadConfig()
        #expect(loaded.projects.map(\.name) == ["b"])
    }

    @Test func rejectsNewerVersion() async throws {
        let paths = temporaryPaths("SauronTests")
        defer { try? FileManager.default.removeItem(at: paths.root) }
        try paths.createLayout()
        try Persistence.write(AppConfig(version: AppConfig.currentVersion + 1), to: paths.configFile)
        let persistence = Persistence(paths: paths)
        await #expect(throws: SauronError.self) {
            _ = try await persistence.loadConfig()
        }
    }
}
