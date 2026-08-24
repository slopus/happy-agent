import AppKit

/// One provider's plan windows, stacked: who they belong to, how much is spent, and a bar each.
///
/// Menu items only carry text, so the bars need a view of their own. The row never highlights and
/// never accepts a click; it is a readout inside the menu. Session and week each get a full-width
/// line so the reset time is not cut off.
final class PlanRowView: NSView {
    private let title = NSTextField(labelWithString: "")
    private let meters: [Meter]

    static let width: CGFloat = 244
    private static let meterHeight: CGFloat = 28
    private static let meterGap: CGFloat = 4

    init(entry: PlanEntry) {
        meters = entry.windows.map { Meter(window: $0, exhausted: entry.exhausted) }
        let height = PlanRowView.height(windowCount: meters.count)
        super.init(frame: NSRect(x: 0, y: 0, width: PlanRowView.width, height: height))
        // Longer conversation titles widen the menu; the bars follow it rather than ending short.
        autoresizingMask = [.width]

        title.stringValue = [entry.name, entry.plan].compactMap { $0 }.joined(separator: " · ")
        title.font = .menuFont(ofSize: 13)
        title.textColor = .labelColor
        title.lineBreakMode = .byTruncatingTail
        title.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        title.translatesAutoresizingMaskIntoConstraints = false
        addSubview(title)
        NSLayoutConstraint.activate([
            title.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 21),
            title.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -14),
            title.topAnchor.constraint(equalTo: topAnchor, constant: 4),
        ])

        var previous: NSView = title
        for (index, meter) in meters.enumerated() {
            meter.translatesAutoresizingMaskIntoConstraints = false
            addSubview(meter)
            NSLayoutConstraint.activate([
                meter.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 21),
                meter.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
                meter.heightAnchor.constraint(equalToConstant: PlanRowView.meterHeight),
                meter.topAnchor.constraint(
                    equalTo: previous.bottomAnchor,
                    constant: index == 0 ? 2 : PlanRowView.meterGap
                ),
            ])
            previous = meter
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("PlanRowView is created in code.")
    }

    private static func height(windowCount: Int) -> CGFloat {
        let meters = CGFloat(max(windowCount, 0))
        let gaps = CGFloat(max(windowCount - 1, 0)) * meterGap
        // Title, then each window on its own line: label, percent, reset, bar.
        return 4 + 18 + 2 + meters * meterHeight + gaps + 8
    }

    /// One full-width window: name, spent share and reset, and a bar underneath.
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
                value.leadingAnchor.constraint(greaterThanOrEqualTo: name.trailingAnchor, constant: 8),
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

private func share(_ window: PlanWindow) -> String {
    let percent = "\(Int(window.usedPercent.rounded()))%"
    guard let reset = resetPhrase(window) else { return percent }
    return "\(percent) · \(reset)"
}

/// Clock time always. A weekday or date when the reset is not today. Remaining time when under 3 hours.
private func resetPhrase(_ window: PlanWindow) -> String? {
    guard let date = window.resetsAt else { return nil }
    var parts = [resetWhen(date)]
    let remaining = date.timeIntervalSinceNow
    if remaining > 0 && remaining < 3 * 60 * 60 {
        parts.append("in \(remainingDuration(remaining))")
    }
    return parts.joined(separator: " · ")
}

private func resetWhen(_ date: Date) -> String {
    let time = clockTime(date)
    if Calendar.current.isDateInToday(date) { return time }
    return "\(resetDay(date)) \(time)"
}

private func resetDay(_ date: Date) -> String {
    let start = Calendar.current.startOfDay(for: Date())
    let end = Calendar.current.startOfDay(for: date)
    let days = Calendar.current.dateComponents([.day], from: start, to: end).day ?? 0
    let formatter = DateFormatter()
    if days > 0 && days < 7 {
        formatter.setLocalizedDateFormatFromTemplate("EEE")
    } else {
        formatter.setLocalizedDateFormatFromTemplate("MMM d")
    }
    return formatter.string(from: date)
}

private func clockTime(_ date: Date) -> String {
    let formatter = DateFormatter()
    formatter.timeStyle = .short
    formatter.dateStyle = .none
    return formatter.string(from: date)
}

private func remainingDuration(_ interval: TimeInterval) -> String {
    let totalSeconds = max(1, Int(interval.rounded(.up)))
    let hours = totalSeconds / 3_600
    let minutes = (totalSeconds % 3_600) / 60
    if hours > 0 { return minutes == 0 ? "\(hours)h" : "\(hours)h \(minutes)m" }
    if minutes > 0 { return "\(minutes)m" }
    return "\(totalSeconds)s"
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
