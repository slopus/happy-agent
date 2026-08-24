import AppKit

/// One provider's plan windows: who they belong to, how much is spent, and a bar for each share.
///
/// Menu items only carry text, so the bars need a view of their own. The row never highlights and
/// never accepts a click; it is a readout inside the menu. Session and week sit next to each
/// other when both exist. A single window keeps the compact title-and-bar layout.
final class PlanRowView: NSView {
    private let title = NSTextField(labelWithString: "")
    private let detail = NSTextField(labelWithString: "")
    private let meters: [Meter]
    private let singlePercent: Double?
    private let exhausted: Bool

    static let width: CGFloat = 244

    init(entry: PlanEntry) {
        exhausted = entry.exhausted
        let dual = entry.windows.count > 1
        if dual {
            meters = entry.windows.map { Meter(window: $0, exhausted: entry.exhausted) }
            singlePercent = nil
        } else {
            meters = []
            singlePercent = entry.windows.first.map { min(max($0.usedPercent, 0), 100) }
        }
        super.init(frame: NSRect(x: 0, y: 0, width: PlanRowView.width, height: dual ? 52 : 40))
        // Longer conversation titles widen the menu; the bars follow it rather than ending short.
        autoresizingMask = [.width]

        title.stringValue = [entry.name, entry.plan].compactMap { $0 }.joined(separator: " · ")
        title.font = .menuFont(ofSize: 13)
        title.textColor = .labelColor
        title.lineBreakMode = .byTruncatingTail
        title.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        title.translatesAutoresizingMaskIntoConstraints = false
        addSubview(title)

        if dual {
            NSLayoutConstraint.activate([
                title.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 21),
                title.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -14),
                title.topAnchor.constraint(equalTo: topAnchor, constant: 4),
            ])
            for meter in meters {
                meter.translatesAutoresizingMaskIntoConstraints = false
                addSubview(meter)
            }
            let first = meters[0]
            let second = meters[1]
            NSLayoutConstraint.activate([
                first.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 21),
                first.topAnchor.constraint(greaterThanOrEqualTo: title.bottomAnchor, constant: 2),
                first.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -6),
                first.heightAnchor.constraint(equalToConstant: 24),
                second.leadingAnchor.constraint(equalTo: first.trailingAnchor, constant: 12),
                second.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
                second.topAnchor.constraint(equalTo: first.topAnchor),
                second.bottomAnchor.constraint(equalTo: first.bottomAnchor),
                first.widthAnchor.constraint(equalTo: second.widthAnchor),
            ])
            return
        }

        if let window = entry.windows.first {
            detail.stringValue = labeledShare(window)
            detail.font = .menuFont(ofSize: 11)
            detail.textColor = .secondaryLabelColor
            detail.alignment = .right
            detail.setContentCompressionResistancePriority(.required, for: .horizontal)
            detail.translatesAutoresizingMaskIntoConstraints = false
            addSubview(detail)
            NSLayoutConstraint.activate([
                title.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 21),
                title.topAnchor.constraint(equalTo: topAnchor, constant: 4),
                detail.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
                detail.firstBaselineAnchor.constraint(equalTo: title.firstBaselineAnchor),
                detail.leadingAnchor.constraint(greaterThanOrEqualTo: title.trailingAnchor, constant: 8),
            ])
        } else {
            NSLayoutConstraint.activate([
                title.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 21),
                title.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -14),
                title.topAnchor.constraint(equalTo: topAnchor, constant: 4),
            ])
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("PlanRowView is created in code.")
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let percent = singlePercent else { return }
        drawPlanBar(
            in: NSRect(x: 21, y: 7, width: bounds.width - 35, height: 3),
            percent: percent,
            exhausted: exhausted
        )
    }

    /// One compact meter: the window's name, its spent share, and a bar.
    private final class Meter: NSView {
        private let percent: Double
        private let exhausted: Bool

        init(window: PlanWindow, exhausted: Bool) {
            percent = min(max(window.usedPercent, 0), 100)
            self.exhausted = exhausted
            super.init(frame: .zero)

            let name = NSTextField(labelWithString: window.label)
            name.font = .menuFont(ofSize: 11)
            name.textColor = .secondaryLabelColor
            name.lineBreakMode = .byTruncatingTail
            name.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

            let value = NSTextField(labelWithString: share(window))
            value.font = .menuFont(ofSize: 11)
            value.textColor = .secondaryLabelColor
            value.alignment = .right
            value.setContentCompressionResistancePriority(.required, for: .horizontal)
            value.setContentHuggingPriority(.required, for: .horizontal)

            for label in [name, value] {
                label.translatesAutoresizingMaskIntoConstraints = false
                addSubview(label)
            }
            NSLayoutConstraint.activate([
                name.leadingAnchor.constraint(equalTo: leadingAnchor),
                name.topAnchor.constraint(equalTo: topAnchor),
                value.trailingAnchor.constraint(equalTo: trailingAnchor),
                value.firstBaselineAnchor.constraint(equalTo: name.firstBaselineAnchor),
                value.leadingAnchor.constraint(greaterThanOrEqualTo: name.trailingAnchor, constant: 6),
            ])
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) {
            fatalError("Meter is created in code.")
        }

        override func draw(_ dirtyRect: NSRect) {
            drawPlanBar(
                in: NSRect(x: 0, y: 2, width: bounds.width, height: 3),
                percent: percent,
                exhausted: exhausted
            )
        }
    }
}

private func labeledShare(_ window: PlanWindow) -> String {
    let percent = "\(Int(window.usedPercent.rounded()))%"
    guard let resetsAt = window.resetsAt else { return "\(window.label) \(percent)" }
    return "\(window.label) \(percent) · resets \(resetPhrase(until: resetsAt))"
}

private func share(_ window: PlanWindow) -> String {
    let percent = "\(Int(window.usedPercent.rounded()))%"
    guard let resetsAt = window.resetsAt else { return percent }
    return "\(percent) · \(resetPhrase(until: resetsAt))"
}

/// A clock time when the window resets today, a weekday when it resets this week, otherwise a date.
private func resetPhrase(until date: Date) -> String {
    let calendar = Calendar.current
    if calendar.isDateInToday(date) {
        let formatter = DateFormatter()
        formatter.timeStyle = .short
        formatter.dateStyle = .none
        return formatter.string(from: date)
    }
    let start = calendar.startOfDay(for: Date())
    let end = calendar.startOfDay(for: date)
    let days = calendar.dateComponents([.day], from: start, to: end).day ?? 0
    if days > 0 && days < 7 {
        let formatter = DateFormatter()
        formatter.setLocalizedDateFormatFromTemplate("EEE")
        return formatter.string(from: date)
    }
    let formatter = DateFormatter()
    formatter.dateStyle = .short
    formatter.timeStyle = .none
    return formatter.string(from: date)
}

private func drawPlanBar(in track: NSRect, percent: Double, exhausted: Bool) {
    let radius = track.height / 2
    NSColor.quaternaryLabelColor.setFill()
    NSBezierPath(roundedRect: track, xRadius: radius, yRadius: radius).fill()

    let filled = track.width * CGFloat(percent / 100)
    guard filled > 0 else { return }
    let fill = NSRect(
        x: track.minX,
        y: track.minY,
        width: max(filled, track.height),
        height: track.height
    )
    (exhausted ? NSColor.systemRed : NSColor.controlAccentColor).setFill()
    NSBezierPath(roundedRect: fill, xRadius: radius, yRadius: radius).fill()
}
