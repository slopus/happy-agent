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
    private let headlineItem = NSMenuItem()
    private let quitItem = NSMenuItem(title: "Quit Happy", action: #selector(quitHappy), keyEquivalent: "")
    private let quitter: QuitHappy
    private let separatorItem = NSMenuItem.separator()
    private let bodyItem = NSMenuItem()
    private let body = MenuBody()
    private let fetchQueue = DispatchQueue(label: "com.slopus.happy.menubar.fetch")
    private let streamQueue = DispatchQueue(label: "com.slopus.happy.menubar.stream")

    private var snapshot = DaemonSnapshot()
    private var planBook = PlanBook()
    /// When each agent's running turn began, from run events or, for a turn already running when
    /// the menu bar started, the agent's history. Only ever touched on the main thread.
    private var turnStarts: [String: Date] = [:]
    /// Agents whose history has been asked for and had no running turn, so it is not asked again
    /// until they stop working.
    private var turnLookups: Set<String> = []
    private var pendingRefresh: DispatchWorkItem?
    private var animation: Timer?
    private var iconAnimation = StatusIconAnimation()
    private var randomness = SystemRandomNumberGenerator()
    private var openMenuTick: Timer?
    private var isMenuOpen = false

    private static let planRefreshInterval: TimeInterval = 24 * 60 * 60
    private static let refreshCoalescingDelay: TimeInterval = 0.2
    private static let reconnectDelay: TimeInterval = 2

    init(client: DaemonClient) {
        self.client = client
        self.quitter = QuitHappy(client: client)
        super.init()
    }

    func start() {
        menu.delegate = self
        menu.autoenablesItems = false
        menu.showsStateColumn = false
        bodyItem.view = body.view
        for item in [headlineItem, NSMenuItem.separator(), quitItem, separatorItem, bodyItem] {
            item.isEnabled = false
            menu.addItem(item)
        }
        quitItem.target = self
        quitItem.isEnabled = true
        statusItem.menu = menu
        statusItem.button?.image = StatusIcon.resting
        statusItem.button?.toolTip = "Happy Agent"
        // Reduce Motion can be switched while the app runs; the icon follows it at once.
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.stopAnimating()
            self?.updateIcon()
        }
        Timer.scheduledTimer(withTimeInterval: MenuBarController.planRefreshInterval, repeats: true) {
            [weak self] _ in
            self?.refreshPlans()
        }
        refreshAgents()
        refreshPlans()
        streamQueue.async { [weak self] in self?.follow() }
    }

    @objc private func quitHappy() {
        guard quitItem.isEnabled else { return }
        quitItem.isEnabled = false
        quitItem.title = "Quitting Happy…"
        menu.cancelTracking()
        quitter.quit(desktopApplications: QuitHappy.desktopApplications) { [weak self] error in
            guard let self, let error else { return }
            self.quitItem.isEnabled = true
            self.quitItem.title = "Quit Happy"
            let alert = NSAlert()
            alert.messageText = "Could not quit Happy"
            alert.informativeText = error
            alert.addButton(withTitle: "OK")
            NSApp.activate(ignoringOtherApps: true)
            alert.runModal()
        }
    }

    // MARK: - Reading the daemon

    /// Follows the event stream for as long as it lasts, then waits and opens another one.
    private func follow() {
        while true {
            client.streamEvents { [weak self] type, data in
                guard let self else { return }
                if let change = DaemonSnapshotReader.turnChange(type: type, data: data) {
                    DispatchQueue.main.async { [weak self] in self?.apply(turn: change) }
                }
                if changesTheMenu(type) { self.scheduleRefresh() }
            }
            // Run events may have been missed while the stream was down, so every turn start is
            // read again from history once it is back.
            DispatchQueue.main.async { [weak self] in
                self?.turnStarts = [:]
                self?.turnLookups = []
                self?.markDisconnected()
            }
            Thread.sleep(forTimeInterval: MenuBarController.reconnectDelay)
            refreshAgents()
        }
    }

    private func changesTheMenu(_ type: String) -> Bool {
        if type == "provider.usage.updated" || type == "config.updated" { refreshPlans() }
        return type.hasPrefix("agent.") || type.hasPrefix("task.") || type.hasPrefix("bot.")
            || type.hasPrefix("run.")
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
            let bots = self.client.get("/v0/bots")
            let tasks = self.client.get("/v0/tasks?scope=joined")
            guard let entries = DaemonSnapshotReader.work(botsBody: bots, tasksBody: tasks) else {
                DispatchQueue.main.async { [weak self] in self?.markDisconnected() }
                return
            }
            DispatchQueue.main.async { [weak self] in self?.apply(work: entries) }
        }
    }

    /// Reads, from history, when the running turns the stream did not announce began: turns
    /// already running when the menu bar started or reconnected. Each agent is asked once.
    private func lookUpTurns(_ agentIds: [String]) {
        turnLookups.formUnion(agentIds)
        fetchQueue.async { [weak self] in
            guard let self else { return }
            for agentId in agentIds {
                let history = self.client.get(
                    "/v0/agents/\(agentId)/messages?limit=1&omitToolData=true"
                )
                guard let start = DaemonSnapshotReader.runningTurnStart(messagesBody: history)
                else { continue }
                DispatchQueue.main.async { [weak self] in
                    guard let self, self.turnStarts[agentId] == nil else { return }
                    self.turnStarts[agentId] = start
                    if self.isMenuOpen { self.rebuildMenu() }
                }
            }
        }
    }

    private func refreshPlans(refreshAccounts: Bool = false) {
        fetchQueue.async { [weak self] in
            guard let self else { return }
            if refreshAccounts { self.client.refreshUsage() }
            guard let read = DaemonSnapshotReader.plans(
                usageBody: self.client.get("/v0/usage"),
                configBody: self.client.get("/v0/config")
            ) else {
                return
            }
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.snapshot.vendors = self.planBook.update(read.0)
                self.snapshot.day = read.1
                if self.isMenuOpen { self.rebuildMenu() }
            }
        }
    }

    // MARK: - Applying what was read

    private func apply(work: [WorkEntry]) {
        snapshot.connected = true
        snapshot.work = work
        let working = Set(work.flatMap(\.workingAgentIds))
        // An agent that stopped working forgets its turn; one that starts again gets a new one.
        turnStarts = turnStarts.filter { working.contains($0.key) }
        turnLookups = turnLookups.intersection(working)
        let unknown = work.flatMap(\.workingAgentIds).filter {
            turnStarts[$0] == nil && !turnLookups.contains($0)
        }
        if !unknown.isEmpty { lookUpTurns(unknown) }
        updateIcon()
        if isMenuOpen { rebuildMenu() }
    }

    private func apply(turn: (agentId: String, startedAt: Date?)) {
        turnStarts[turn.agentId] = turn.startedAt
        if isMenuOpen { rebuildMenu() }
    }

    /// When the turn a task or bot is busy with began: its own agent's, or else the first working
    /// subtask whose start is known.
    private func turnStart(_ entry: WorkEntry) -> Date? {
        entry.workingAgentIds.lazy.compactMap { self.turnStarts[$0] }.first
    }

    private func markDisconnected() {
        snapshot.connected = false
        snapshot.work = []
        updateIcon()
        if isMenuOpen { rebuildMenu() }
    }

    // MARK: - Drawing

    /// The H at rest when nothing is working, flashing while something is, and greyed out the way
    /// macOS greys any disabled status item while the daemon is not answering.
    ///
    /// The animation timer exists only while work is in flight, and a frame where no cell changed
    /// redraws nothing. With Reduce Motion on there is no timer at all: the middle cell stays
    /// dimmed instead, so working still reads differently from idle without anything moving.
    private func updateIcon() {
        statusItem.button?.appearsDisabled = !snapshot.connected
        let working = !snapshot.working.isEmpty
        guard working else {
            stopAnimating()
            statusItem.button?.image = StatusIcon.resting
            return
        }
        if NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            var strengths = Array(repeating: 1.0, count: StatusIcon.cells.count)
            strengths[StatusIcon.bridge] = StatusIconAnimation.dimmest
            statusItem.button?.image = StatusIcon.image(strengths: strengths)
            return
        }
        guard animation == nil else { return }
        iconAnimation = StatusIconAnimation()
        let timer = Timer.scheduledTimer(
            withTimeInterval: StatusIconAnimation.frameInterval,
            repeats: true
        ) { [weak self] _ in
            guard let self else { return }
            let now = ProcessInfo.processInfo.systemUptime
            guard let strengths = self.iconAnimation.step(at: now, using: &self.randomness) else {
                return
            }
            self.statusItem.button?.image = StatusIcon.image(strengths: strengths)
        }
        // A little slack lets the system batch the wakeups with others.
        timer.tolerance = StatusIconAnimation.frameInterval / 2
        // The menu bar keeps drawing while a menu is tracking, so the H keeps flashing.
        RunLoop.main.add(timer, forMode: .eventTracking)
        animation = timer
    }

    private func stopAnimating() {
        animation?.invalidate()
        animation = nil
    }

    /// Replaces the rows in place: the items stay, so an open menu keeps its scroll position.
    private func rebuildMenu() {
        let headline = MenuContent.headline(snapshot)
        headlineItem.view = headline
        let rows = MenuContent.rows(snapshot: snapshot) { [weak self] entry in
            self?.turnStart(entry)
        }
        let resized = body.show(rows, maxHeight: bodyMaxHeight(below: headline))
        separatorItem.isHidden = body.isEmpty
        bodyItem.isHidden = body.isEmpty
        if resized { menu.itemChanged(bodyItem) }
    }

    /// Space left after the headline, Quit section, separators, and menu padding.
    private func bodyMaxHeight(below headline: NSView) -> CGFloat {
        let screen = statusItem.button?.window?.screen ?? NSScreen.main
        let available = (screen?.visibleFrame.height ?? 800) * MenuMetrics.screenShare
        return available - headline.frame.height - MenuMetrics.rowHeight - 2 * MenuMetrics.separatorHeight
            - MenuMetrics.menuPadding
    }

    // MARK: - NSMenuDelegate

    func menuNeedsUpdate(_ menu: NSMenu) {
        rebuildMenu()
    }

    func menuWillOpen(_ menu: NSMenu) {
        isMenuOpen = true
        // Overlay scrollers stay hidden until someone scrolls, so a list that runs past the bottom
        // shows its scroller once to say there is more.
        RunLoop.main.perform(inModes: [.eventTracking, .default]) { [weak self] in
            self?.body.view.flashScrollers()
        }
        refreshPlans(refreshAccounts: true)
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
