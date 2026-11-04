import AppKit

/// Closes Desktop before stopping the daemon, so Desktop cannot reconnect and restart it.
/// The helper stays alive until the daemon exits through its ordinary supervised shutdown.
final class QuitHappy {
    private let client: DaemonClient
    private var desktopWait: Timer?
    private let shutdownQueue = DispatchQueue(label: "com.slopus.happy.menubar.quit")

    init(client: DaemonClient) {
        self.client = client
    }

    static var desktopApplications: [NSRunningApplication] {
        NSWorkspace.shared.runningApplications.filter { application in
            guard let identifier = application.bundleIdentifier else { return false }
            return identifier == "com.slopus.happy"
                || identifier == "com.slopus.happy.nightly"
                || identifier.hasPrefix("com.slopus.happy.dev.")
        }
    }

    /// Called on the main thread. A refused or stalled Desktop quit leaves the agent running.
    func quit(desktopApplications: [NSRunningApplication], completion: @escaping (String?) -> Void) {
        let applications = desktopApplications.filter { !$0.isTerminated }
        for application in applications {
            guard application.terminate() else {
                completion("Happy Desktop could not quit. Close it and try again.")
                return
            }
        }
        guard !applications.isEmpty else {
            shutdown(completion: completion)
            return
        }
        let deadline = ProcessInfo.processInfo.systemUptime + 15
        let timer = Timer(timeInterval: 0.1, repeats: true) { [weak self] timer in
            guard let self else { timer.invalidate(); return }
            if applications.allSatisfy({ $0.isTerminated }) {
                timer.invalidate()
                self.desktopWait = nil
                self.shutdown(completion: completion)
            } else if ProcessInfo.processInfo.systemUptime >= deadline {
                timer.invalidate()
                self.desktopWait = nil
                completion("Happy Desktop is still closing. Try again once it has quit.")
            }
        }
        desktopWait = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    private func shutdown(completion: @escaping (String?) -> Void) {
        shutdownQueue.async { [client] in
            let accepted = client.shutdown()
            DispatchQueue.main.async {
                completion(accepted ? nil : "Happy Agent could not shut down. Please try again.")
            }
        }
    }
}