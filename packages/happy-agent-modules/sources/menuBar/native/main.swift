import AppKit
import CoreGraphics

/// The Happy Agent menu bar app.
///
/// The daemon starts it, hands it the socket and token it should read, and keeps its standard
/// input open. Closing that input is how a daemon that died without stopping its children still
/// takes the menu bar down with it.

private func argument(_ name: String) -> String? {
    let arguments = CommandLine.arguments
    guard let index = arguments.firstIndex(of: name), index + 1 < arguments.count else {
        return nil
    }
    return arguments[index + 1]
}

private func exitWhenParentClosesInput() {
    let input = FileHandle.standardInput
    input.readabilityHandler = { handle in
        if handle.availableData.isEmpty { exit(0) }
    }
}

guard let socketPath = argument("--socket"), let tokenPath = argument("--token-file") else {
    FileHandle.standardError.write(
        Data("Usage: happy-menu-bar --socket <path> --token-file <path>\n".utf8)
    )
    exit(2)
}

// There is no menu bar to join outside a login session — a daemon started over SSH or by a launch
// daemon, for instance. Leaving quietly tells the daemon this machine simply has nowhere to show.
guard CGSessionCopyCurrentDictionary() != nil else {
    FileHandle.standardError.write(Data("No macOS login session; the menu bar is unavailable.\n".utf8))
    exit(0)
}

let application = NSApplication.shared
// An accessory app lives in the menu bar alone: no Dock icon, no window, and it never takes focus.
application.setActivationPolicy(.accessory)

let controller = MenuBarController(
    client: DaemonClient(socketPath: socketPath, tokenPath: tokenPath)
)

final class MenuBarDelegate: NSObject, NSApplicationDelegate {
    private let controller: MenuBarController

    init(controller: MenuBarController) {
        self.controller = controller
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        controller.start()
    }
}

let delegate = MenuBarDelegate(controller: controller)
application.delegate = delegate
exitWhenParentClosesInput()
application.run()
