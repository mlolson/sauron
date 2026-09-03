import Foundation
import SauronCore

/// Session lifecycle: launch, stop, detach, resume, reconcile.
extension AppState {
    private func requireTools() throws -> (ToolPaths, TmuxService) {
        guard let toolPaths, let tmux else {
            throw SauronError.executableNotFound("tmux")
        }
        return (toolPaths, tmux)
    }

    private func launchEnvironment(sessionId: UUID, toolPaths: ToolPaths) -> [String: String] {
        [
            "PATH": toolPaths.path,
            "TERM": "xterm-256color",
            "COLORTERM": "truecolor",
            "SAURON_SESSION_ID": sessionId.uuidString,
            "SAURON_SOCKET": paths.socketFile.path,
        ]
    }

    private func nextDisplayName(tool: AgentTool, projectId: UUID?) -> String {
        let count = sessions(for: projectId).filter { $0.tool == tool }.count
        return count == 0 ? tool.displayName : "\(tool.displayName) \(count + 1)"
    }

    /// Launches a new Claude Code session in the project directory inside tmux.
    func launchClaude(in project: Project, initialPrompt: String? = nil) async {
        do {
            let (toolPaths, tmux) = try requireTools()
            guard let claude = toolPaths.claude else { throw SauronError.executableNotFound("claude") }
            let id = UUID()
            let cliSessionId = id.uuidString.lowercased()
            let tmuxName = TmuxService.sessionName(slug: project.name, id: id)
            var command = [claude, "--session-id", cliSessionId]
            if let initialPrompt, !initialPrompt.isEmpty { command.append(initialPrompt) }

            try await tmux.newSession(
                name: tmuxName,
                workingDir: project.path,
                sessionEnvironment: launchEnvironment(sessionId: id, toolPaths: toolPaths),
                command: command
            )

            let session = Session(
                id: id,
                projectId: project.id,
                tool: .claude,
                kind: .managed,
                displayName: nextDisplayName(tool: .claude, projectId: project.id),
                tmuxName: tmuxName,
                cliSessionId: cliSessionId,
                transcriptPath: ClaudeTranscripts.transcriptURL(cwd: project.path, sessionId: cliSessionId).path,
                workingDir: project.path,
                state: .running
            )
            append(session: session)
            selection = .session(id)
        } catch {
            report(error)
        }
    }

    /// Starts a new tmux session that resumes a stopped session's conversation.
    func resume(sessionId: UUID) async {
        guard let session = session(id: sessionId), session.state == .stopped, let cliSessionId = session.cliSessionId else { return }
        do {
            let (toolPaths, tmux) = try requireTools()
            let command: [String]
            switch session.tool {
            case .claude:
                guard let claude = toolPaths.claude else { throw SauronError.executableNotFound("claude") }
                command = [claude, "--resume", cliSessionId]
            case .codex:
                guard let codex = toolPaths.codex else { throw SauronError.executableNotFound("codex") }
                command = [codex, "resume", cliSessionId]
            }
            let tmuxName = TmuxService.sessionName(slug: session.displayName, id: UUID())
            try await tmux.newSession(
                name: tmuxName,
                workingDir: session.worktreePath ?? session.workingDir,
                sessionEnvironment: launchEnvironment(sessionId: session.id, toolPaths: toolPaths),
                command: command
            )
            terminals.close(sessionId: sessionId)
            update(sessionId: sessionId) {
                $0.tmuxName = tmuxName
                $0.state = .running
                $0.stateSource = .inferred
                $0.lastActivityAt = Date()
            }
            selection = .session(sessionId)
        } catch {
            report(error)
        }
    }

    /// Interrupts the agent, then kills the tmux session if it is still there.
    func stop(sessionId: UUID) async {
        guard let session = session(id: sessionId), let tmuxName = session.tmuxName else { return }
        do {
            let (_, tmux) = try requireTools()
            if await tmux.hasSession(tmuxName) {
                try await tmux.sendInterrupt(to: tmuxName)
                try await Task.sleep(for: .seconds(2))
                if await tmux.hasSession(tmuxName) {
                    try await tmux.killSession(tmuxName)
                }
            }
            terminals.close(sessionId: sessionId)
            markStopped(sessionId: sessionId)
        } catch {
            report(error)
        }
    }

    /// Closes the embedded terminal but leaves the tmux session running.
    func detach(sessionId: UUID) {
        terminals.close(sessionId: sessionId)
        if selection == .session(sessionId), let projectId = session(id: sessionId)?.projectId {
            selection = .project(projectId)
        }
    }

    func markStopped(sessionId: UUID) {
        update(sessionId: sessionId) {
            $0.state = .stopped
            $0.lastActivityAt = Date()
        }
    }

    // MARK: Orphans

    /// Adopts a tmux session Sauron does not have a record for, as an unassigned session.
    func adoptOrphan(_ tmuxName: String) {
        let session = Session(
            projectId: nil,
            tool: .claude,
            kind: .managed,
            displayName: tmuxName,
            tmuxName: tmuxName,
            workingDir: NSHomeDirectory(),
            state: .running
        )
        append(session: session)
        setOrphans(orphanTmuxSessions.filter { $0 != tmuxName })
        selection = .session(session.id)
    }

    func killOrphan(_ tmuxName: String) async {
        do {
            let (_, tmux) = try requireTools()
            try await tmux.killSession(tmuxName)
            setOrphans(orphanTmuxSessions.filter { $0 != tmuxName })
            if selection == .orphan(tmuxName) { selection = nil }
        } catch {
            report(error)
        }
    }

    // MARK: Reconciliation

    /// Matches persisted sessions against live tmux sessions.
    func reconcileSessions() async {
        guard let tmux else { return }
        do {
            let live = Set(try await tmux.listSauronSessions())
            var known = Set<String>()
            for session in sessions where session.kind == .managed {
                guard let name = session.tmuxName else { continue }
                known.insert(name)
                if live.contains(name) {
                    if session.state == .stopped {
                        update(sessionId: session.id) { $0.state = .idle }
                    }
                } else if session.state != .stopped {
                    markStopped(sessionId: session.id)
                }
            }
            setOrphans(live.subtracting(known).sorted())
        } catch {
            report(error)
        }
    }

    /// Periodic check that alive sessions still have their tmux session.
    func checkLiveness() async {
        guard let tmux else { return }
        for session in sessions where session.kind == .managed && session.isAlive {
            guard let name = session.tmuxName else { continue }
            if await !tmux.hasSession(name) {
                terminals.close(sessionId: session.id)
                markStopped(sessionId: session.id)
            }
        }
    }
}
