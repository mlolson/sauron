import SwiftUI
import SwiftTerm
import os

private let logger = Logger(subsystem: "com.mattolson.sauron", category: "terminal")

/// Hosts a SwiftTerm terminal that is owned by the TerminalRegistry.
struct SessionTerminalView: NSViewRepresentable {
    let terminal: LocalProcessTerminalView

    func makeNSView(context: Context) -> LocalProcessTerminalView {
        terminal
    }

    func updateNSView(_ nsView: LocalProcessTerminalView, context: Context) {
        FileHandle.standardError.write(("updateNSView frame=\(nsView.frame.debugDescription) window=\(nsView.window != nil) superview=\(nsView.superview?.frame.debugDescription ?? "nil") cols=\(nsView.getTerminal().cols) rows=\(nsView.getTerminal().rows)" + "\n").data(using: .utf8)!)
        DispatchQueue.main.async {
            nsView.window?.makeFirstResponder(nsView)
            FileHandle.standardError.write(("after async frame=\(nsView.frame.debugDescription) hidden=\(nsView.isHiddenOrHasHiddenAncestor)" + "\n").data(using: .utf8)!)
        }
    }
}
