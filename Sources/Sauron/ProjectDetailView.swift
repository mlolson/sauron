import SwiftUI
import SauronCore

struct ProjectDetailView: View {
    @Environment(AppState.self) private var appState
    let project: Project

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                header
                summarySection
                sessionsSection
            }
            .padding(24)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .navigationTitle(project.name)
        .toolbar {
            ToolbarItem {
                Button {
                    Task { await appState.launchClaude(in: project) }
                } label: {
                    Label("New Claude", systemImage: "plus.bubble")
                }
                .help("Start a Claude Code session in this project")
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(project.name)
                .font(.largeTitle.bold())
            HStack(spacing: 6) {
                Text((project.path as NSString).abbreviatingWithTildeInPath)
                    .font(.callout.monospaced())
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                Button {
                    NSWorkspace.shared.activateFileViewerSelecting([project.url])
                } label: {
                    Image(systemName: "arrow.up.forward.square")
                }
                .buttonStyle(.plain)
                .help("Reveal in Finder")
            }
        }
    }

    private var summarySection: some View {
        GroupBox("Status") {
            Text("No summary yet. The master agent will write one in a later slice.")
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var sessionsSection: some View {
        GroupBox("Sessions") {
            let sessions = appState.sessions(for: project.id)
            if sessions.isEmpty {
                Text("No sessions yet. Use New Claude to start one.")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                VStack(spacing: 0) {
                    ForEach(sessions) { session in
                        Button {
                            appState.selection = .session(session.id)
                        } label: {
                            HStack {
                                SessionRow(session: session)
                                Text(session.createdAt, style: .relative)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .padding(.vertical, 4)
                        if session.id != sessions.last?.id { Divider() }
                    }
                }
            }
        }
    }
}
