import Foundation
import SauronCore

/// `sauron://` URL commands, usable from the shell with `open`:
///   sauron://launch?project=<name or id>&tool=claude[&prompt=...]
///   sauron://select?project=<name or id>
extension AppState {
    func handle(commandURL url: URL) async {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return }
        let query = Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).compactMap { item in
            item.value.map { (item.name, $0) }
        })
        func findProject() -> Project? {
            guard let key = query["project"] else { return nil }
            return projects.first { $0.id.uuidString.caseInsensitiveCompare(key) == .orderedSame || $0.name == key || $0.path == key }
        }
        switch components.host {
        case "launch":
            guard let project = findProject() else {
                errorMessage = "sauron://launch: unknown project \(query["project"] ?? "")"
                return
            }
            switch query["tool"] ?? "claude" {
            case "claude":
                await launchClaude(in: project, initialPrompt: query["prompt"])
            default:
                errorMessage = "sauron://launch: unsupported tool \(query["tool"] ?? "")"
            }
        case "select":
            if let project = findProject() { selection = .project(project.id) }
            if let key = query["session"], let session = sessions.first(where: { $0.id.uuidString.caseInsensitiveCompare(key) == .orderedSame }) {
                selection = .session(session.id)
            }
        default:
            errorMessage = "Unknown command URL: \(url)"
        }
    }
}
