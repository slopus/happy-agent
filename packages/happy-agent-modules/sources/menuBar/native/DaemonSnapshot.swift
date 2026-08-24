import Foundation

/// One agent the person can see, and what it is doing right now.
struct AgentEntry {
    let id: String
    let title: String
    let activity: String?

    var isWorking: Bool { activity != nil }
}

/// The agents of one project, gathered from the project's own workspaces.
struct ProjectEntry {
    let name: String
    let working: [AgentEntry]
}

/// Which quota window this is. Session resets are a time of day; week and month can be a day.
enum PlanWindowKind {
    case session
    case week
    case month
    case fable

    var label: String {
        switch self {
        case .session: return "Session"
        case .week: return "Week"
        case .month: return "Month"
        case .fable: return "Fable"
        }
    }
}

/// One named quota window: how much is spent, and when it starts over.
struct PlanWindow {
    let kind: PlanWindowKind
    let usedPercent: Double
    let resetsAt: Date?

    var label: String { kind.label }
}

/// A provider's plan, with the session and week windows the menu shows side by side.
struct PlanEntry {
    let name: String
    let plan: String?
    let windows: [PlanWindow]
    let exhausted: Bool
}

struct TokenTotals {
    var input = 0
    var output = 0

    var isEmpty: Bool { input == 0 && output == 0 }
}

/// Everything the menu draws, as of the last successful read.
struct DaemonSnapshot {
    var connected = false
    var projects: [ProjectEntry] = []
    var plans: [PlanEntry] = []
    var hour = TokenTotals()
    var day = TokenTotals()

    var workingCount: Int { projects.reduce(0) { $0 + $1.working.count } }
}

/// Reads the daemon's projects, workspaces, and usage into the shape the menu draws.
///
/// Agents live on workspaces — including each project's root workspace — so the workspace list
/// alone carries every visible agent, and the project list supplies the names to group them under.
enum DaemonSnapshotReader {
    static func projects(projectsBody: Any?, workspacesBody: Any?) -> [ProjectEntry]? {
        guard let projectRows = (projectsBody as? [String: Any])?["projects"] as? [[String: Any]],
            let workspaceRows = (workspacesBody as? [String: Any])?["workspaces"] as? [[String: Any]]
        else {
            return nil
        }
        var names: [String: String] = [:]
        var order: [String] = []
        for row in projectRows {
            guard let id = row["id"] as? String else { continue }
            names[id] = row["name"] as? String ?? "Untitled project"
            order.append(id)
        }
        var working: [String: [AgentEntry]] = [:]
        for row in workspaceRows {
            guard let projectId = row["projectId"] as? String else { continue }
            let agents = row["agents"] as? [[String: Any]] ?? []
            for agent in agents {
                guard let entry = agentEntry(agent), entry.isWorking else { continue }
                working[projectId, default: []].append(entry)
            }
        }
        return order.compactMap { id in
            guard let agents = working[id], !agents.isEmpty else { return nil }
            return ProjectEntry(name: names[id] ?? "Untitled project", working: agents)
        }
    }

    static func plans(usageBody: Any?) -> ([PlanEntry], TokenTotals, TokenTotals)? {
        guard let body = usageBody as? [String: Any] else { return nil }
        var plans: [PlanEntry] = []
        for provider in body["providers"] as? [[String: Any]] ?? [] {
            guard let id = provider["providerId"] as? String else { continue }
            guard provider["enabled"] as? Bool ?? true else { continue }
            guard let usage = provider["usage"] as? [String: Any] else { continue }
            let windows = usageWindows(usage["windows"] as? [String: Any])
            guard !windows.isEmpty else { continue }
            plans.append(
                PlanEntry(
                    name: providerName(id),
                    plan: usage["planName"] as? String,
                    windows: windows,
                    exhausted: usage["exhausted"] as? Bool ?? false
                )
            )
        }
        return (plans, totals(body["hour"]), totals(body["day"]))
    }

    private static func agentEntry(_ agent: [String: Any]) -> AgentEntry? {
        guard let id = agent["id"] as? String else { return nil }
        let title = agent["title"] as? String ?? "Untitled conversation"
        return AgentEntry(id: id, title: title, activity: activity(agent["status"] as? String))
    }

    /// The daemon's granular run status as something a person reads at a glance.
    private static func activity(_ status: String?) -> String? {
        switch status {
        case "thinking": return "Thinking"
        case "working": return "Responding"
        case "generating_tools": return "Preparing tools"
        case "running_tools": return "Running tools"
        default: return nil
        }
    }

    /// A configured provider's ID as something to read. A person names their own accounts, so an
    /// unfamiliar ID becomes words rather than being shown as the raw identifier it is.
    private static func providerName(_ id: String) -> String {
        switch id {
        case "claude": return "Claude"
        case "codex": return "Codex"
        case "grok": return "Grok"
        case "bedrock": return "Bedrock"
        default:
            return id
                .split(whereSeparator: { $0 == "_" || $0 == "-" || $0 == "." })
                .map { $0.prefix(1).uppercased() + $0.dropFirst() }
                .joined(separator: " ")
        }
    }

    /// Every provider uses the same windows: session and week when the vendor reports them, and a
    /// monthly window only when there is no session, so a week-and-month pair still has both.
    private static func usageWindows(_ windows: [String: Any]?) -> [PlanWindow] {
        guard let windows else { return [] }
        var shown: [PlanWindow] = []
        if let session = window(windows["fiveHour"], kind: .session) {
            shown.append(session)
        }
        if let week = window(windows["weekly"], kind: .week) {
            shown.append(week)
        }
        if let fable = window(windows["fableWeekly"], kind: .fable) {
            shown.append(fable)
        }
        if shown.count < 2, let month = window(windows["monthly"], kind: .month) {
            shown.append(month)
        }
        return shown
    }

    private static func window(_ raw: Any?, kind: PlanWindowKind) -> PlanWindow? {
        guard let body = raw as? [String: Any], let percent = number(body["usedPercent"]) else {
            return nil
        }
        return PlanWindow(kind: kind, usedPercent: percent, resetsAt: date(body["resetsAt"]))
    }

    /// JSONSerialization turns whole numbers into `NSNumber`/`Int`, so a direct `as? Double` misses
    /// the percentages and timestamps a vendor reports as integers.
    private static func number(_ value: Any?) -> Double? {
        if let n = value as? NSNumber { return n.doubleValue }
        if let n = value as? Double { return n }
        if let n = value as? Int { return Double(n) }
        return nil
    }

    private static func date(_ value: Any?) -> Date? {
        guard let ms = number(value) else { return nil }
        return Date(timeIntervalSince1970: ms / 1000)
    }

    private static func totals(_ window: Any?) -> TokenTotals {
        var totals = TokenTotals()
        guard let providers = window as? [String: Any] else { return totals }
        for models in providers.values {
            guard let models = models as? [String: Any] else { continue }
            for usage in models.values {
                guard let usage = usage as? [String: Any] else { continue }
                totals.input += usage["input"] as? Int ?? 0
                totals.output += usage["output"] as? Int ?? 0
            }
        }
        return totals
    }
}
