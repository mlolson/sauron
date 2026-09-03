import SwiftUI
import SauronCore
import UniformTypeIdentifiers

struct ContentView: View {
    @Environment(AppState.self) private var appState

    var body: some View {
        @Bindable var appState = appState
        Group {
            if appState.setupIsRequired, let toolPaths = appState.toolPaths {
                SetupView(toolPaths: toolPaths)
            } else {
                mainSplit
            }
        }
        .frame(minWidth: 900, minHeight: 560)
        .onDrop(of: [.fileURL], isTargeted: nil) { providers in
            handleDrop(providers)
        }
        .alert("Sauron", isPresented: Binding(
            get: { appState.errorMessage != nil },
            set: { if !$0 { appState.errorMessage = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(appState.errorMessage ?? "")
        }
    }

    private var mainSplit: some View {
        @Bindable var appState = appState
        return NavigationSplitView {
            SidebarView()
        } detail: {
            switch appState.selection {
            case .project(let id):
                if let project = appState.project(id: id) {
                    ProjectDetailView(project: project)
                } else {
                    EmptyDetailView()
                }
            case .session(let id):
                if let session = appState.session(id: id) {
                    SessionView(session: session)
                        .id(session.id)
                } else {
                    EmptyDetailView()
                }
            case .orphan(let name):
                OrphanSessionView(tmuxName: name)
            case .master:
                MasterPlaceholderView()
            case nil:
                EmptyDetailView()
            }
        }
    }

    private func handleDrop(_ providers: [NSItemProvider]) -> Bool {
        let fileProviders = providers.filter { $0.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) }
        guard !fileProviders.isEmpty else { return false }
        Task {
            var urls: [URL] = []
            for provider in fileProviders {
                if let url = await provider.loadFileURL() {
                    urls.append(url)
                }
            }
            await appState.addProjects(at: urls)
        }
        return true
    }
}

private extension NSItemProvider {
    func loadFileURL() async -> URL? {
        await withCheckedContinuation { continuation in
            loadItem(forTypeIdentifier: UTType.fileURL.identifier) { item, _ in
                if let data = item as? Data, let url = URL(dataRepresentation: data, relativeTo: nil) {
                    continuation.resume(returning: url)
                } else if let url = item as? URL {
                    continuation.resume(returning: url)
                } else {
                    continuation.resume(returning: nil)
                }
            }
        }
    }
}

struct EmptyDetailView: View {
    @Environment(AppState.self) private var appState

    var body: some View {
        ContentUnavailableView {
            Label("No Project Selected", systemImage: "eye")
        } description: {
            Text("Add a git repository to start tracking it, or drop a folder onto the window.")
        } actions: {
            Button("Add Project…") { appState.presentAddProjectPanel() }
        }
    }
}

struct MasterPlaceholderView: View {
    var body: some View {
        ContentUnavailableView(
            "Master Agent",
            systemImage: "brain",
            description: Text("The coordinating agent arrives in a later slice.")
        )
    }
}
