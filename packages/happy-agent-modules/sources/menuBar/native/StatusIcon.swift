import AppKit

/// The glyph in the menu bar: a star with softened corners, still while nothing is happening and
/// turning while agents work. It is drawn as a template image at full strength, so macOS tints it
/// exactly like every other menu bar icon and inverts it while the menu is open.
enum StatusIcon {
    private static let size = NSSize(width: 16, height: 16)
    /// The finished star: how far the points reach, and how deep the notches cut.
    private static let radius: CGFloat = 7.5
    private static let waistRatio: CGFloat = 0.46
    /// How far the points and notches are rounded off. Enough to soften every corner, little
    /// enough that the arms stay distinct — past about a fifth of the radius it reads as a flower.
    private static let rounding: CGFloat = 0.9

    private static let arms = 5

    /// `phase` is the rotation in radians, which advances only while work is in flight.
    static func image(phase: Double, working: Bool) -> NSImage {
        let image = NSImage(size: size, flipped: false) { _ in
            // Rounding comes from stroking a smaller, sharper star with round joins: the stroke
            // grows the shape back to full size while turning every corner, point and notch alike,
            // into an arc. Tangent arcs cannot do this — the points are far too sharp to fit one.
            let path = starPath(rotation: working ? phase : 0)
            path.lineJoinStyle = .round
            path.lineWidth = rounding * 2
            NSColor.black.setFill()
            NSColor.black.setStroke()
            path.fill()
            path.stroke()
            return true
        }
        image.isTemplate = true
        return image
    }

    private static func starPath(rotation: Double) -> NSBezierPath {
        let center = NSPoint(x: size.width / 2, y: size.height / 2)
        let reach = radius - rounding
        let waist = radius * waistRatio - rounding
        let path = NSBezierPath()
        let step = Double.pi / Double(arms)
        for corner in 0..<(arms * 2) {
            // Measured from straight up, so a resting star sits upright.
            let angle = Double.pi / 2 + rotation + Double(corner) * step
            let distance = corner.isMultiple(of: 2) ? reach : waist
            let point = NSPoint(
                x: center.x + distance * CGFloat(cos(angle)),
                y: center.y + distance * CGFloat(sin(angle))
            )
            if corner == 0 { path.move(to: point) } else { path.line(to: point) }
        }
        path.close()
        return path
    }
}
