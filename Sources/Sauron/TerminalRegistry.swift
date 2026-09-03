import AppKit
import SauronCore
import SwiftTerm
import os

/// Keeps one live terminal view per open session so switching tabs does not re-attach.
@MainActor
final class TerminalRegistry {
    private var terminals: [UUID: LocalProcessTerminalView] = [:]
    private var delegates: [UUID: AttachDelegate] = [:]

    func isOpen(sessionId: UUID) -> Bool {
        terminals[sessionId] != nil
    }

    /// Returns the existing terminal for the session, or creates one attached to its tmux session.
    func terminal(for session: Session, tmux: TmuxService, onExit: @escaping @MainActor () -> Void) -> LocalProcessTerminalView {
        if let existing = terminals[session.id] { return existing }
        guard let tmuxName = session.tmuxName else {
            preconditionFailure("terminal requested for a session without a tmux name")
        }
        let view = LocalProcessTerminalView(frame: NSRect(x: 0, y: 0, width: 800, height: 600))
        view.font = NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
        let delegate = AttachDelegate(onExit: onExit)
        view.processDelegate = delegate
        delegates[session.id] = delegate
        terminals[session.id] = view

        let env = tmux.environment.map { "\($0.key)=\($0.value)" }
        view.startProcess(
            executable: tmux.attachExecutable,
            args: TmuxService.attachArguments(name: tmuxName),
            environment: env,
            currentDirectory: session.worktreePath ?? session.workingDir
        )
        return view
    }

    /// Ends the attach client. The tmux session itself is untouched.
    func close(sessionId: UUID) {
        guard let view = terminals.removeValue(forKey: sessionId) else { return }
        delegates.removeValue(forKey: sessionId)
        view.processDelegate = nil
        view.terminate()
    }
}

private final class AttachDelegate: LocalProcessTerminalViewDelegate {
    private let onExit: @MainActor () -> Void

    init(onExit: @escaping @MainActor () -> Void) {
        self.onExit = onExit
    }

    func sizeChanged(source: LocalProcessTerminalView, newCols: Int, newRows: Int) {
        FileHandle.standardError.write(("sizeChanged \(newCols)x\(newRows) frame=\(source.frame.debugDescription)" + "\n").data(using: .utf8)!)
    }
    func setTerminalTitle(source: LocalProcessTerminalView, title: String) {}
    func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}

    func processTerminated(source: TerminalView, exitCode: Int32?) {
        let onExit = onExit
        Task { @MainActor in onExit() }
    }
}
