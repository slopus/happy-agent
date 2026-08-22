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

/// The share of a provider's plan that has been spent, and when the window starts over.
struct PlanEntry {
    let name: String
    let plan: String?
    let usedPercent: Double
    let resetsAt: Date?
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
            guard let window = constrainingWindow(usage["windows"] as? [String: Any]) else {
                continue
            }
            plans.append(
                PlanEntry(
                    name: providerName(id),
                    plan: usage["planName"] as? String,
                    usedPercent: window.percent,
                    resetsAt: window.resetsAt,
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

    /// The window closest to running out, which is the one worth showing in a single row.
    private static func constrainingWindow(
        _ windows: [String: Any]?
    ) -> (percent: Double, resetsAt: Date?)? {
        guard let windows else { return nil }
        var best: (percent: Double, resetsAt: Date?)?
        for key in ["fiveHour", "weekly", "monthly"] {
            guard let window = windows[key] as? [String: Any],
                let percent = window["usedPercent"] as? Double
            else {
                continue
            }
            if let current = best, current.percent >= percent { continue }
            let resetsAt = (window["resetsAt"] as? Double).map {
                Date(timeIntervalSince1970: $0 / 1000)
            }
            best = (percent, resetsAt)
        }
        return best
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
