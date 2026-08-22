import AppKit

/// One provider's plan window: who it belongs to, how much is spent, and a bar showing the share.
///
/// Menu items only carry text, so the bar needs a view of its own. The row never highlights and
/// never accepts a click; it is a readout inside the menu.
final class PlanRowView: NSView {
    private let title = NSTextField(labelWithString: "")
    private let detail = NSTextField(labelWithString: "")
    private let percent: Double
    private let exhausted: Bool

    static let width: CGFloat = 244

    init(entry: PlanEntry) {
        percent = min(max(entry.usedPercent, 0), 100)
        exhausted = entry.exhausted
        super.init(frame: NSRect(x: 0, y: 0, width: PlanRowView.width, height: 40))
        // Longer conversation titles widen the menu; the bar follows it rather than ending short.
        autoresizingMask = [.width]

        title.stringValue = [entry.name, entry.plan].compactMap { $0 }.joined(separator: " · ")
        title.font = .menuFont(ofSize: 13)
        title.textColor = .labelColor

        detail.stringValue = detailText(for: entry)
        detail.font = .menuFont(ofSize: 11)
        detail.textColor = .secondaryLabelColor
        detail.alignment = .right

        for label in [title, detail] {
            label.translatesAutoresizingMaskIntoConstraints = false
            addSubview(label)
        }
        NSLayoutConstraint.activate([
            title.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 21),
            title.topAnchor.constraint(equalTo: topAnchor, constant: 4),
            detail.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
            detail.firstBaselineAnchor.constraint(equalTo: title.firstBaselineAnchor),
            detail.leadingAnchor.constraint(greaterThanOrEqualTo: title.trailingAnchor, constant: 8),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("PlanRowView is created in code.")
    }

    override func draw(_ dirtyRect: NSRect) {
        let track = NSRect(x: 21, y: 7, width: bounds.width - 35, height: 3)
        let radius = track.height / 2
        NSColor.quaternaryLabelColor.setFill()
        NSBezierPath(roundedRect: track, xRadius: radius, yRadius: radius).fill()

        let filled = track.width * CGFloat(percent / 100)
        guard filled > 0 else { return }
        let fill = NSRect(x: track.minX, y: track.minY, width: max(filled, track.height), height: track.height)
        (exhausted ? NSColor.systemRed : NSColor.controlAccentColor).setFill()
        NSBezierPath(roundedRect: fill, xRadius: radius, yRadius: radius).fill()
    }

    private func detailText(for entry: PlanEntry) -> String {
        let share = "\(Int(entry.usedPercent.rounded()))%"
        guard let resetsAt = entry.resetsAt else { return share }
        let formatter = DateFormatter()
        formatter.timeStyle = .short
        formatter.dateStyle = .none
        return "\(share) · resets \(formatter.string(from: resetsAt))"
    }
}
