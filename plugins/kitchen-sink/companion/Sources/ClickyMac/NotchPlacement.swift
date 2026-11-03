import AppKit

/// Screen coordinates, including the hardware cutout rather than the menu-bar inset.
struct NotchPlacement: Equatable {
    let frame: CGRect
    let cutoutWidth: CGFloat
    let rowHeight: CGFloat
    let wingWidth: CGFloat

    init(screenFrame: CGRect, visibleFrame: CGRect? = nil, safeTop: CGFloat, leftArea: CGRect?, rightArea: CGRect?, expanded: Bool = true) {
        let cutout: CGRect?
        if safeTop > 0, let leftArea, let rightArea, rightArea.minX > leftArea.maxX {
            cutout = CGRect(x: leftArea.maxX, y: screenFrame.maxY - safeTop,
                width: rightArea.minX - leftArea.maxX, height: safeTop)
        } else { cutout = nil }
        cutoutWidth = cutout.map { $0.width + 8 } ?? 0
        wingWidth = cutout == nil || !expanded ? 0 : 110
        rowHeight = cutout?.height ?? 40
        let width = cutout == nil ? 290 : cutoutWidth + 2 * wingWidth
        let height = rowHeight + (cutout == nil ? 0 : 4)
        frame = CGRect(x: (cutout?.midX ?? screenFrame.midX) - width / 2,
            y: (cutout == nil ? (visibleFrame ?? screenFrame).maxY : screenFrame.maxY) - height, width: width, height: height)
    }

    init(screen: NSScreen, expanded: Bool = true) {
        self.init(screenFrame: screen.frame, visibleFrame: screen.visibleFrame, safeTop: screen.safeAreaInsets.top,
            leftArea: screen.auxiliaryTopLeftArea, rightArea: screen.auxiliaryTopRightArea, expanded: expanded)
    }

    static var screen: NSScreen? {
        NSScreen.screens.first { $0.safeAreaInsets.top > 0 }
            ?? NSScreen.screens.first { screen in
                guard let id = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { return false }
                return CGDisplayIsBuiltin(id.uint32Value) != 0
            } ?? NSScreen.screens.first
    }

    func expandedFrame(size: CGSize, visibleFrame: CGRect) -> CGRect {
        let width = min(size.width, visibleFrame.width - 24)
        let height = min(size.height, max(0, frame.minY - visibleFrame.minY))
        let x = min(max(frame.midX - width / 2, visibleFrame.minX + 12), visibleFrame.maxX - width - 12)
        return CGRect(x: x, y: frame.minY - height, width: width, height: height)
    }
}

/// AppKit must not push the launcher down into the menu-bar-safe desktop area.
final class NotchPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
}
