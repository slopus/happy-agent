import AppKit

/// Owns the menu bar item: what it shows, when it refreshes, and how it follows the daemon.
///
/// Reading happens on background queues and everything visible is applied on the main thread. The
/// daemon's event stream is used only as a signal that something changed; the snapshots the menu
/// draws are always re-read, so a missed or unfamiliar event can never leave stale state behind.
final class MenuBarController: NSObject, NSMenuDelegate {
    private let client: DaemonClient
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let menu = NSMenu()
    private let fetchQueue = DispatchQueue(label: "com.slopus.happy.menubar.fetch")
    private let streamQueue = DispatchQueue(label: "com.slopus.happy.menubar.stream")

    private var snapshot = DaemonSnapshot()
    private var workingSince: [String: Date] = [:]
    private var pendingRefresh: DispatchWorkItem?
    private var animation: Timer?
    private var openMenuTick: Timer?
    private var isMenuOpen = false
    private var phase = 0.0

    private static let planRefreshInterval: TimeInterval = 60
    /// A calm three seconds per turn, fast enough to read as activity and slow enough to ignore.
    private static let spinFrameInterval: TimeInterval = 1.0 / 30
    private static let spinPerFrame = 2 * Double.pi / (3 * 30)
    private static let refreshCoalescingDelay: TimeInterval = 0.2
    private static let reconnectDelay: TimeInterval = 2

    init(client: DaemonClient) {
        self.client = client
        super.init()
    }

    func start() {
        menu.delegate = self
        menu.autoenablesItems = false
        statusItem.menu = menu
        statusItem.button?.image = StatusIcon.image(phase: 0, working: false)
        statusItem.button?.toolTip = "Happy Agent"
        Timer.scheduledTimer(withTimeInterval: MenuBarController.planRefreshInterval, repeats: true) {
            [weak self] _ in
            self?.refreshPlans()
        }
        refreshAgents()
        refreshPlans()
        streamQueue.async { [weak self] in self?.follow() }
    }

    // MARK: - Reading the daemon

    /// Follows the event stream for as long as it lasts, then waits and opens another one.
    private func follow() {
        while true {
            client.streamEventTypes { [weak self] type in
                guard let self, changesTheMenu(type) else { return }
                self.scheduleRefresh()
            }
            DispatchQueue.main.async { [weak self] in self?.markDisconnected() }
            Thread.sleep(forTimeInterval: MenuBarController.reconnectDelay)
            refreshAgents()
        }
    }

    private func changesTheMenu(_ type: String) -> Bool {
        type.hasPrefix("agent.") || type.hasPrefix("workspace.") || type.hasPrefix("project.")
    }

    /// Coalesces the bursts of events a single turn produces into one read.
    private func scheduleRefresh() {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.pendingRefresh?.cancel()
            let work = DispatchWorkItem { [weak self] in self?.refreshAgents() }
            self.pendingRefresh = work
            self.fetchQueue.asyncAfter(
                deadline: .now() + MenuBarController.refreshCoalescingDelay,
                execute: work
            )
        }
    }

    private func refreshAgents() {
        fetchQueue.async { [weak self] in
            guard let self else { return }
            let projects = self.client.get("/v0/projects")
            let workspaces = self.client.get("/v0/workspaces")
            guard let entries = DaemonSnapshotReader.projects(
                projectsBody: projects,
                workspacesBody: workspaces
            ) else {
                DispatchQueue.main.async { [weak self] in self?.markDisconnected() }
                return
            }
            DispatchQueue.main.async { [weak self] in self?.apply(projects: entries) }
        }
    }

    private func refreshPlans() {
        fetchQueue.async { [weak self] in
            guard let self else { return }
            guard let read = DaemonSnapshotReader.plans(usageBody: self.client.get("/v0/usage"))
            else {
                return
            }
            DispatchQueue.main.async { [weak self] in
                self?.snapshot.plans = read.0
                self?.snapshot.hour = read.1
                self?.snapshot.day = read.2
            }
        }
    }

    // MARK: - Applying what was read

    private func apply(projects: [ProjectEntry]) {
        snapshot.connected = true
        snapshot.projects = projects
        let now = Date()
        var running: [String: Date] = [:]
        for project in projects {
            for agent in project.working {
                running[agent.id] = workingSince[agent.id] ?? now
            }
        }
        workingSince = running
        updateIcon()
        if isMenuOpen { rebuildMenu() }
    }

    private func markDisconnected() {
        snapshot.connected = false
        snapshot.projects = []
        workingSince = [:]
        updateIcon()
        if isMenuOpen { rebuildMenu() }
    }

    // MARK: - Drawing

    private func updateIcon() {
        let working = snapshot.workingCount > 0
        if working, animation == nil {
            let timer = Timer.scheduledTimer(
                withTimeInterval: MenuBarController.spinFrameInterval,
                repeats: true
            ) { [weak self] _ in
                guard let self else { return }
                self.phase += MenuBarController.spinPerFrame
                self.statusItem.button?.image = StatusIcon.image(phase: self.phase, working: true)
            }
            // The menu bar keeps drawing while a menu is tracking, so the star keeps turning.
            RunLoop.main.add(timer, forMode: .eventTracking)
            animation = timer
        }
        if !working {
            animation?.invalidate()
            animation = nil
            phase = 0
        }
        statusItem.button?.image = StatusIcon.image(phase: phase, working: working)
    }

    private func rebuildMenu() {
        menu.removeAllItems()
        for item in MenuContent.items(snapshot: snapshot, workingSince: { [weak self] id in
            self?.workingSince[id]
        }) {
            menu.addItem(item)
        }
    }

    // MARK: - NSMenuDelegate

    func menuNeedsUpdate(_ menu: NSMenu) {
        rebuildMenu()
    }

    func menuWillOpen(_ menu: NSMenu) {
        isMenuOpen = true
        refreshPlans()
        // Elapsed times are the only thing that moves without an event to announce it.
        openMenuTick = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            self?.rebuildMenu()
        }
        if let openMenuTick { RunLoop.main.add(openMenuTick, forMode: .eventTracking) }
    }

    func menuDidClose(_ menu: NSMenu) {
        isMenuOpen = false
        openMenuTick?.invalidate()
        openMenuTick = nil
    }
}
