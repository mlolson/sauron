import SwiftUI
import SauronCore

@main
struct SauronApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var appState = AppState(persistence: Persistence(paths: .standard()))

    var body: some Scene {
        WindowGroup("Sauron") {
            ContentView()
                .environment(appState)
                .task {
                    delegate.appState = appState
                    await appState.load()
                }
        }
        .commands {
            CommandGroup(after: .newItem) {
                Button("Add Project…") { appState.presentAddProjectPanel() }
                    .keyboardShortcut("o", modifiers: .command)
            }
        }
    }
}
