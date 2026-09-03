import SwiftUI
import SauronCore

struct SidebarView: View {
    @Environment(AppState.self) private var appState

    var body: some View {
        @Bindable var appState = appState
        List(selection: $appState.selection) {
            Section {
                Label("Master Agent", systemImage: "brain")
                    .tag(SidebarItem.master)
            }
            Section("Projects") {
                ForEach(appState.projects) { project in
                    DisclosureGroup {
                        ForEach(appState.sessions(for: project.id)) { session in
                            SessionRow(session: session)
                                .tag(SidebarItem.session(session.id))
                                .contextMenu { sessionMenu(session) }
                        }
                    } label: {
                        ProjectRow(project: project, aliveCount: appState.aliveSessionCount(for: project.id))
                            .tag(SidebarItem.project(project.id))
                            .contextMenu { projectMenu(project) }
                    }
                }
            }
            let unassigned = appState.sessions(for: nil)
            if !unassigned.isEmpty {
                Section("Unassigned Sessions") {
                    ForEach(unassigned) { session in
                        SessionRow(session: session)
                            .tag(SidebarItem.session(session.id))
                            .contextMenu { sessionMenu(session) }
                    }
                }
            }
            if !appState.orphanTmuxSessions.isEmpty {
                Section("Unknown Sauron Sessions") {
                    ForEach(appState.orphanTmuxSessions, id: \.self) { name in
                        Label(name, systemImage: "questionmark.circle")
                            .tag(SidebarItem.orphan(name))
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .navigationSplitViewColumnWidth(min: 220, ideal: 280)
        .toolbar {
            ToolbarItem {
                Button {
                    appState.presentAddProjectPanel()
                } label: {
                    Label("Add Project", systemImage: "plus")
                }
                .help("Add a git repository")
            }
        }
    }

    @ViewBuilder
    private func projectMenu(_ project: Project) -> some View {
        Button("New Claude Session") { Task { await appState.launchClaude(in: project) } }
        Divider()
        Button("Reveal in Finder") {
            NSWorkspace.shared.activateFileViewerSelecting([project.url])
        }
        Divider()
        Button("Remove from Sauron", role: .destructive) { confirmRemove(project) }
    }

    @ViewBuilder
    private func sessionMenu(_ session: Session) -> some View {
        if session.isAlive {
            Button("Detach Terminal") { appState.detach(sessionId: session.id) }
            Button("Stop", role: .destructive) { Task { await appState.stop(sessionId: session.id) } }
        } else {
            if session.cliSessionId != nil {
                Button("Resume") { Task { await appState.resume(sessionId: session.id) } }
            }
            Button("Forget", role: .destructive) { appState.removeSession(id: session.id) }
        }
    }

    private func confirmRemove(_ project: Project) {
        let alert = NSAlert()
        alert.messageText = "Remove \(project.name) from Sauron?"
        alert.informativeText = "The directory on disk is not touched. Only the entry in Sauron is removed."
        alert.addButton(withTitle: "Remove")
        alert.addButton(withTitle: "Cancel")
        alert.alertStyle = .warning
        if alert.runModal() == .alertFirstButtonReturn {
            appState.removeProject(id: project.id)
        }
    }
}

struct ProjectRow: View {
    let project: Project
    let aliveCount: Int

    var body: some View {
        HStack {
            Image(systemName: "folder")
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(project.name)
                Text(abbreviatedPath)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer()
            if aliveCount > 0 {
                Text("\(aliveCount)")
                    .font(.caption.monospacedDigit())
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1)
                    .background(Color.secondary.opacity(0.2), in: Capsule())
            }
        }
    }

    private var abbreviatedPath: String {
        (project.path as NSString).abbreviatingWithTildeInPath
    }
}

struct SessionRow: View {
    let session: Session

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: session.tool == .claude ? "sparkle" : "chevron.left.forwardslash.chevron.right")
                .foregroundStyle(session.isAlive ? Color.accentColor : Color.secondary)
            Text(session.displayName)
                .foregroundStyle(session.isAlive ? .primary : .secondary)
            Spacer()
            SessionStateDot(state: session.state)
        }
    }
}
