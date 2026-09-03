import SwiftUI
import SauronCore

/// Detail view for a managed session: a tab strip of the project's open sessions and the terminal.
struct SessionView: View {
    @Environment(AppState.self) private var appState
    let session: Session

    private var siblings: [Session] {
        appState.sessions(for: session.projectId).filter { $0.isAlive || $0.id == session.id }
    }

    var body: some View {
        VStack(spacing: 0) {
            tabStrip
            Divider()
            content
        }
        .navigationTitle(session.displayName)
        .navigationSubtitle(projectName)
        .toolbar { toolbarContent }
    }

    private var projectName: String {
        session.projectId.flatMap { appState.project(id: $0)?.name } ?? "Unassigned"
    }

    private var tabStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 4) {
                ForEach(siblings) { sibling in
                    SessionTab(session: sibling, isSelected: sibling.id == session.id) {
                        appState.selection = .session(sibling.id)
                    }
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
        }
        .background(.bar)
    }

    @ViewBuilder
    private var content: some View {
        if session.state == .stopped {
            ContentUnavailableView {
                Label("Session Stopped", systemImage: "stop.circle")
            } description: {
                Text("The tmux session is gone. Resume continues the same conversation in a new one.")
            } actions: {
                if session.cliSessionId != nil {
                    Button("Resume") { Task { await appState.resume(sessionId: session.id) } }
                        .buttonStyle(.borderedProminent)
                }
                Button("Forget") { appState.removeSession(id: session.id) }
            }
        } else if let tmux = appState.tmux {
            let sessionId = session.id
            SessionTerminalView(terminal: appState.terminals.terminal(for: session, tmux: tmux) {
                Task { await appState.checkLiveness() }
                appState.terminals.close(sessionId: sessionId)
            })
            .background(Color.black)
        } else {
            ContentUnavailableView("tmux Not Found", systemImage: "exclamationmark.triangle")
        }
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItemGroup {
            if session.isAlive {
                Button {
                    appState.detach(sessionId: session.id)
                } label: {
                    Label("Detach", systemImage: "rectangle.portrait.and.arrow.right")
                }
                .help("Close this terminal; the session keeps running in tmux")

                Button(role: .destructive) {
                    Task { await appState.stop(sessionId: session.id) }
                } label: {
                    Label("Stop", systemImage: "stop.fill")
                }
                .help("Interrupt the agent and end the tmux session")
            }
            if let tmuxName = session.tmuxName, session.isAlive {
                Button {
                    let pasteboard = NSPasteboard.general
                    pasteboard.clearContents()
                    pasteboard.setString("tmux attach -t \(tmuxName)", forType: .string)
                } label: {
                    Label("Copy Attach Command", systemImage: "terminal")
                }
                .help("Copy `tmux attach -t \(tmuxName)`")
            }
        }
    }
}

struct SessionTab: View {
    let session: Session
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                SessionStateDot(state: session.state)
                Text(session.displayName)
                    .lineLimit(1)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(isSelected ? Color.accentColor.opacity(0.2) : Color.clear, in: RoundedRectangle(cornerRadius: 6))
        }
        .buttonStyle(.plain)
    }
}

struct SessionStateDot: View {
    let state: SessionState

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 8, height: 8)
            .help(label)
    }

    private var color: Color {
        switch state {
        case .running: return .green
        case .waitingForInput: return .orange
        case .idle: return .blue
        case .stopped: return .gray
        }
    }

    private var label: String {
        switch state {
        case .running: return "Running"
        case .waitingForInput: return "Waiting for input"
        case .idle: return "Idle"
        case .stopped: return "Stopped"
        }
    }
}

/// Detail for a tmux session Sauron has no record of.
struct OrphanSessionView: View {
    @Environment(AppState.self) private var appState
    let tmuxName: String

    var body: some View {
        ContentUnavailableView {
            Label(tmuxName, systemImage: "questionmark.circle")
        } description: {
            Text("This tmux session has Sauron's prefix but no record, probably from a lost sessions.json. Adopt it to attach, or kill it.")
        } actions: {
            Button("Adopt") { appState.adoptOrphan(tmuxName) }
                .buttonStyle(.borderedProminent)
            Button("Kill", role: .destructive) { Task { await appState.killOrphan(tmuxName) } }
        }
        .navigationTitle(tmuxName)
    }
}
