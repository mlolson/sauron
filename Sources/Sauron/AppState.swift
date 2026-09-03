import AppKit
import Foundation
import Observation
import SauronCore
import os

/// Central observable state for the UI. Main-actor only.
@MainActor
@Observable
final class AppState {
    private static let logger = Logger(subsystem: "com.mattolson.sauron", category: "appstate")

    private(set) var projects: [Project] = []
    var selection: SidebarItem?
    var errorMessage: String?
    private(set) var isLoaded = false

    private let persistence: Persistence

    init(persistence: Persistence) {
        self.persistence = persistence
    }

    // MARK: Loading

    func load() async {
        guard !isLoaded else { return }
        do {
            let config = try await persistence.loadConfig()
            projects = config.projects
            isLoaded = true
        } catch {
            Self.logger.error("load failed: \(error.localizedDescription, privacy: .public)")
            errorMessage = error.localizedDescription
        }
    }

    private func persist() {
        let config = AppConfig(projects: projects)
        Task { await persistence.saveConfig(config) }
    }

    // MARK: Projects

    func project(id: UUID) -> Project? {
        projects.first { $0.id == id }
    }

    /// Validates that `url` is inside a git repository and adds the repository root.
    func addProject(at url: URL) async {
        do {
            let root = try await GitRepository.toplevel(of: url)
            if projects.contains(where: { $0.url.standardizedFileURL == root }) {
                throw SauronError.projectAlreadyAdded(root.path)
            }
            let project = Project(name: root.lastPathComponent, path: root.path)
            projects.append(project)
            persist()
            selection = .project(project.id)
        } catch {
            Self.logger.error("add project failed: \(error.localizedDescription, privacy: .public)")
            errorMessage = error.localizedDescription
        }
    }

    func addProjects(at urls: [URL]) async {
        for url in urls {
            await addProject(at: url)
        }
    }

    func removeProject(id: UUID) {
        projects.removeAll { $0.id == id }
        if selection == .project(id) { selection = nil }
        persist()
    }

    func presentAddProjectPanel() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = true
        panel.prompt = "Add Project"
        panel.message = "Choose a git repository directory."
        guard panel.runModal() == .OK else { return }
        let urls = panel.urls
        Task { await addProjects(at: urls) }
    }
}

enum SidebarItem: Hashable {
    case master
    case project(UUID)
}
