import SwiftUI
import SauronCore

/// Shown instead of the main window when a required tool is missing.
struct SetupView: View {
    @Environment(AppState.self) private var appState
    let toolPaths: ToolPaths

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Label("Sauron needs a few tools", systemImage: "wrench.and.screwdriver")
                .font(.title2.bold())
            Text("These were not found on your login shell's PATH:")
            VStack(alignment: .leading, spacing: 8) {
                ForEach(toolPaths.missingRequired, id: \.self) { tool in
                    HStack(alignment: .top) {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(.red)
                        VStack(alignment: .leading) {
                            Text(tool).font(.headline.monospaced())
                            Text(hint(for: tool)).font(.callout).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            Text("PATH searched:").font(.caption).foregroundStyle(.secondary)
            Text(toolPaths.path)
                .font(.caption.monospaced())
                .textSelection(.enabled)
                .lineLimit(4)
            HStack {
                Spacer()
                Button("Check Again") {
                    Task { await appState.resolveTools() }
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .padding(28)
        .frame(width: 560)
    }

    private func hint(for tool: String) -> String {
        switch tool {
        case "claude": return "Install Claude Code: curl -fsSL https://claude.ai/install.sh | bash"
        case "tmux": return "Install with Homebrew: brew install tmux"
        case "git": return "Install the Xcode Command Line Tools: xcode-select --install"
        default: return ""
        }
    }
}
