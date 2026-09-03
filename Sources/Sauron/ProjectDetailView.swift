import SwiftUI
import SauronCore

struct ProjectDetailView: View {
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
            Text("No sessions. Launching agents arrives in the next slice.")
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
