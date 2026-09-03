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
                    ProjectRow(project: project)
                        .tag(SidebarItem.project(project.id))
                        .contextMenu {
                            Button("Reveal in Finder") {
                                NSWorkspace.shared.activateFileViewerSelecting([project.url])
                            }
                            Divider()
                            Button("Remove from Sauron", role: .destructive) {
                                confirmRemove(project)
                            }
                        }
                }
            }
        }
        .listStyle(.sidebar)
        .navigationSplitViewColumnWidth(min: 200, ideal: 260)
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
        }
    }

    private var abbreviatedPath: String {
        (project.path as NSString).abbreviatingWithTildeInPath
    }
}
