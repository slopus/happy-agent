import AppKit

/// Builds the menu from a snapshot: what is running, where, and what the plans have left.
enum MenuContent {
    static func items(
        snapshot: DaemonSnapshot,
        workingSince: (String) -> Date?
    ) -> [NSMenuItem] {
        var items: [NSMenuItem] = [caption(headline(snapshot))]
        for project in snapshot.projects {
            items.append(.separator())
            items.append(sectionHeader(project.name))
            for agent in project.working {
                items.append(agentItem(agent, since: workingSince(agent.id)))
            }
        }
        if !snapshot.plans.isEmpty {
            items.append(.separator())
            items.append(sectionHeader("Plan usage"))
            for plan in snapshot.plans {
                let item = NSMenuItem()
                item.view = PlanRowView(entry: plan)
                items.append(item)
            }
        }
        let tokens = tokenLines(snapshot)
        if !tokens.isEmpty {
            items.append(.separator())
            items.append(sectionHeader("Tokens"))
            items.append(contentsOf: tokens.map { caption($0) })
        }
        return items
    }

    private static func headline(_ snapshot: DaemonSnapshot) -> String {
        guard snapshot.connected else { return "Waiting for the Happy agent…" }
        let count = snapshot.workingCount
        if count == 0 { return "Every agent is idle" }
        let projects = snapshot.projects.count
        let agents = count == 1 ? "1 agent working" : "\(count) agents working"
        return projects == 1 ? agents : "\(agents) in \(projects) projects"
    }

    private static func tokenLines(_ snapshot: DaemonSnapshot) -> [String] {
        var lines: [String] = []
        if !snapshot.hour.isEmpty { lines.append("Last hour · \(tokens(snapshot.hour))") }
        if !snapshot.day.isEmpty { lines.append("Last 24 hours · \(tokens(snapshot.day))") }
        return lines
    }

    private static func tokens(_ totals: TokenTotals) -> String {
        "\(compact(totals.input)) in · \(compact(totals.output)) out"
    }

    private static func compact(_ count: Int) -> String {
        if count >= 1_000_000 { return String(format: "%.1fM", Double(count) / 1_000_000) }
        if count >= 1_000 { return "\(count / 1_000)K" }
        return "\(count)"
    }

    /// Long enough for a real conversation title, short enough that one cannot widen the menu.
    private static let titleLimit = 44

    private static func agentItem(_ agent: AgentEntry, since: Date?) -> NSMenuItem {
        var detail = agent.activity ?? ""
        if let since, let elapsed = duration(since: since) { detail += " · \(elapsed)" }
        return caption(shortened(agent.title), detail: detail)
    }

    private static func shortened(_ title: String) -> String {
        guard title.count > titleLimit else { return title }
        return "\(title.prefix(titleLimit - 1).trimmingCharacters(in: .whitespaces))…"
    }

    /// Elapsed working time, once it has been running long enough to be worth reading.
    private static func duration(since: Date) -> String? {
        let seconds = Int(Date().timeIntervalSince(since))
        guard seconds >= 2 else { return nil }
        if seconds < 60 { return "\(seconds)s" }
        let minutes = seconds / 60
        if minutes < 60 { return "\(minutes)m \(seconds % 60)s" }
        return "\(minutes / 60)h \(minutes % 60)m"
    }

    private static func sectionHeader(_ text: String) -> NSMenuItem {
        let item = NSMenuItem()
        item.isEnabled = false
        item.attributedTitle = NSAttributedString(
            string: text.uppercased(),
            attributes: [
                .font: NSFont.systemFont(ofSize: 10, weight: .semibold),
                .foregroundColor: NSColor.tertiaryLabelColor,
                .kern: 0.6,
            ]
        )
        return item
    }

    private static func caption(_ text: String, detail: String = "") -> NSMenuItem {
        let item = NSMenuItem()
        item.isEnabled = false
        let title = NSMutableAttributedString(
            string: text,
            attributes: [
                .font: NSFont.menuFont(ofSize: 13),
                .foregroundColor: NSColor.labelColor,
            ]
        )
        if !detail.isEmpty {
            title.append(
                NSAttributedString(
                    string: "\n\(detail)",
                    attributes: [
                        .font: NSFont.menuFont(ofSize: 11),
                        .foregroundColor: NSColor.secondaryLabelColor,
                    ]
                )
            )
        }
        item.attributedTitle = title
        return item
    }
}
