import AppKit
import SauronCore

/// Handles folder opens from Finder, `open -a Sauron <dir>`, and drag-to-Dock.
final class AppDelegate: NSObject, NSApplicationDelegate {
    weak var appState: AppState?

    func application(_ application: NSApplication, open urls: [URL]) {
        guard let appState else { return }
        Task { @MainActor in
            await appState.addProjects(at: urls)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }
}
