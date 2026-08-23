import AppKit
import CoreGraphics

/// The Happy Agent menu bar app.
///
/// The daemon starts it, hands it the socket and token it should read, and keeps its standard
/// input open. The app never outlives that daemon: a daemon killed outright never gets to stop its
/// children, so the app watches for its death itself.

private func argument(_ name: String) -> String? {
    let arguments = CommandLine.arguments
    guard let index = arguments.firstIndex(of: name), index + 1 < arguments.count else {
        return nil
    }
    return arguments[index + 1]
}

/// Held for the process's life: a dispatch source stops delivering once it is released.
private var parentWatch: DispatchSourceProcess?

/// Ends the app when the daemon that started it goes away.
///
/// Two independent signals say it is gone, and either one is enough. The standard input the daemon
/// holds open reaches end of file when its side closes, which covers a daemon that exited without
/// its children being reparented yet. Watching the parent process itself covers the rest, including
/// an input pipe left open by something else in the chain.
private func exitWhenParentGoesAway() {
    FileHandle.standardInput.readabilityHandler = { handle in
        if handle.availableData.isEmpty { exit(0) }
    }
    let parent = getppid()
    // A parent of one means the daemon died before the app got this far and launchd adopted it.
    guard parent > 1 else { exit(0) }
    let watch = DispatchSource.makeProcessSource(identifier: parent, eventMask: .exit)
    watch.setEventHandler { exit(0) }
    watch.resume()
    parentWatch = watch
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
exitWhenParentGoesAway()
application.run()
