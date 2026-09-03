import AppKit
import SauronCore

/// Handles folder opens from Finder, `open -a Sauron <dir>`, and drag-to-Dock.
final class AppDelegate: NSObject, NSApplicationDelegate {
    weak var appState: AppState?

    func application(_ application: NSApplication, open urls: [URL]) {
        guard let appState else { return }
        let files = urls.filter(\.isFileURL)
        let commands = urls.filter { $0.scheme == "sauron" }
        Task { @MainActor in
            await appState.addProjects(at: files)
            for url in commands {
                await appState.handle(commandURL: url)
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }
}
