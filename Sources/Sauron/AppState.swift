import AppKit
import Foundation
import Observation
import SauronCore
import os

/// Central observable state for the UI. Main-actor only.
@MainActor
@Observable
final class AppState {
    static let logger = Logger(subsystem: "com.mattolson.sauron", category: "appstate")

    private(set) var projects: [Project] = []
    private(set) var sessions: [Session] = []
    /// tmux sessions with Sauron's prefix that have no record in sessions.json.
    private(set) var orphanTmuxSessions: [String] = []
    private(set) var toolPaths: ToolPaths?
    var selection: SidebarItem?
    var errorMessage: String?
    private(set) var isLoaded = false

    let persistence: Persistence
    let paths: AppPaths
    let terminals = TerminalRegistry()
    private(set) var tmux: TmuxService?
    private var livenessTask: Task<Void, Never>?

    init(persistence: Persistence) {
        self.persistence = persistence
        self.paths = persistence.paths
    }

    var setupIsRequired: Bool {
        guard let toolPaths else { return false }
        return !toolPaths.missingRequired.isEmpty
    }

    // MARK: Loading

    func load() async {
        guard !isLoaded else { return }
        do {
            let config = try await persistence.loadConfig()
            projects = config.projects
            sessions = try await persistence.loadSessions().sessions
            isLoaded = true
        } catch {
            Self.logger.error("load failed: \(error.localizedDescription, privacy: .public)")
            errorMessage = error.localizedDescription
        }
        await resolveTools()
        await reconcileSessions()
        startLivenessPolling()
    }

    func resolveTools() async {
        let resolved = await CLIResolver.resolve()
        toolPaths = resolved
        if let git = resolved.git { GitRepository.gitExecutable = git }
        if let tmuxPath = resolved.tmux {
            tmux = TmuxService(tmuxPath: tmuxPath, environment: CLIResolver.sessionEnvironment(path: resolved.path))
        } else {
            tmux = nil
        }
    }

    func report(_ error: Error) {
        Self.logger.error("\(error.localizedDescription, privacy: .public)")
        errorMessage = error.localizedDescription
    }

    private func persistConfig() {
        let config = AppConfig(projects: projects)
        Task { await persistence.saveConfig(config) }
    }

    func persistSessions() {
        let file = SessionsFile(sessions: sessions)
        Task {
            do {
                try await persistence.saveSessions(file)
            } catch {
                report(error)
            }
        }
    }

    // MARK: Projects

    func project(id: UUID) -> Project? {
        projects.first { $0.id == id }
    }

    func session(id: UUID) -> Session? {
        sessions.first { $0.id == id }
    }

    func sessions(for projectId: UUID?) -> [Session] {
        sessions.filter { $0.projectId == projectId }
    }

    func aliveSessionCount(for projectId: UUID) -> Int {
        sessions(for: projectId).filter(\.isAlive).count
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
            persistConfig()
            selection = .project(project.id)
        } catch {
            report(error)
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
        persistConfig()
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

    // MARK: Session mutation helpers

    func update(sessionId: UUID, _ change: (inout Session) -> Void) {
        guard let index = sessions.firstIndex(where: { $0.id == sessionId }) else { return }
        change(&sessions[index])
        persistSessions()
    }

    func append(session: Session) {
        sessions.append(session)
        persistSessions()
    }

    func setOrphans(_ names: [String]) {
        orphanTmuxSessions = names
    }

    func removeSession(id: UUID) {
        terminals.close(sessionId: id)
        sessions.removeAll { $0.id == id }
        if selection == .session(id) { selection = nil }
        persistSessions()
    }

    // MARK: Liveness

    private func startLivenessPolling() {
        livenessTask?.cancel()
        livenessTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                guard let self else { return }
                await self.checkLiveness()
            }
        }
    }
}

enum SidebarItem: Hashable {
    case master
    case project(UUID)
    case session(UUID)
    case orphan(String)
}
