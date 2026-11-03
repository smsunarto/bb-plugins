import AppKit
import ApplicationServices
import Carbon
import ClickyCore

nonisolated struct ContextApplication: Sendable {
    let pid: pid_t
    let name: String
    let bundleID: String?
    let omitValues: Bool
}

nonisolated enum AccessibilityContext {
    /// AX objects never leave this concurrent function. Every IPC, including
    /// child reads, inherits an explicit timeout on that exact AX object.
    @concurrent static func read(_ target: ContextApplication) async -> DesktopContext {
        var result = DesktopContext(application: target.name, bundleID: target.bundleID, accessibility: .unavailable)
        guard AXIsProcessTrusted() else { result.accessibility = .permissionDenied; return result }
        let deadline = ContinuousClock.now.advanced(by: .milliseconds(500))
        func remaining() -> Float {
            let seconds = ContinuousClock.now.duration(to: deadline).components
            return max(0, min(0.08, Float(seconds.seconds) + Float(seconds.attoseconds) / 1e18))
        }
        func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
            let timeout = remaining()
            guard timeout > 0, !Task.isCancelled else { return nil }
            AXUIElementSetMessagingTimeout(element, timeout)
            var value: CFTypeRef?
            return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
        }
        func attributes(_ element: AXUIElement, _ names: [String]) -> [CFTypeRef] {
            let timeout = remaining()
            guard timeout > 0, !Task.isCancelled else { return [] }
            AXUIElementSetMessagingTimeout(element, timeout)
            var values: CFArray?
            guard AXUIElementCopyMultipleAttributeValues(element, names as CFArray, [], &values) == .success else { return [] }
            return values as? [CFTypeRef] ?? []
        }
        func string(_ value: CFTypeRef?) -> String? { (value as? String).map { String($0.prefix(500)) } }
        func rect(_ values: [CFTypeRef], _ position: Int, _ size: Int) -> CGRect? {
            guard values.count > max(position, size), CFGetTypeID(values[position]) == AXValueGetTypeID(), CFGetTypeID(values[size]) == AXValueGetTypeID() else { return nil }
            var point = CGPoint.zero; var dimensions = CGSize.zero
            guard AXValueGetValue(unsafeDowncast(values[position], to: AXValue.self), .cgPoint, &point),
                  AXValueGetValue(unsafeDowncast(values[size], to: AXValue.self), .cgSize, &dimensions),
                  [point.x, point.y, dimensions.width, dimensions.height].allSatisfy(\.isFinite), dimensions.width >= 0, dimensions.height >= 0 else { return nil }
            return CGRect(origin: point, size: dimensions)
        }
        let app = AXUIElementCreateApplication(target.pid)
        guard let rawWindow = attribute(app, kAXFocusedWindowAttribute) ?? attribute(app, kAXMainWindowAttribute),
              CFGetTypeID(rawWindow) == AXUIElementGetTypeID() else { return result }
        let window = unsafeDowncast(rawWindow, to: AXUIElement.self)
        let header = attributes(window, [kAXTitleAttribute, kAXPositionAttribute, kAXSizeAttribute])
        guard let windowFrame = rect(header, 1, 2), !windowFrame.isEmpty else { return result }
        result.window = string(header.first)
        result.windowBounds = ContextRect(windowFrame)
        // CG display bounds use the same top-left global point space as AX.
        var displayCount: UInt32 = 0
        CGGetActiveDisplayList(0, nil, &displayCount)
        var displays = [CGDirectDisplayID](repeating: 0, count: Int(displayCount))
        CGGetActiveDisplayList(displayCount, &displays, &displayCount)
        guard let display = displays.max(by: { windowFrame.intersection(CGDisplayBounds($0)).area < windowFrame.intersection(CGDisplayBounds($1)).area }),
              windowFrame.intersects(CGDisplayBounds(display)) else { return result }
        result.displayID = display; result.displayBounds = ContextRect(CGDisplayBounds(display))
        result.accessibility = .available
        let visibleFrame = windowFrame.intersection(CGDisplayBounds(display))
        var pending: [(AXUIElement, Int?, Int, CGRect)] = [(window, nil, 0, visibleFrame)]
        var visited = Set<CFHashCode>()
        var examined = 0
        while let (element, parent, depth, clip) = pending.popLast(), result.nodes.count < 120, examined < 400, remaining() > 0, !Task.isCancelled {
            examined += 1
            guard visited.insert(CFHash(element)).inserted else { continue }
            let identity = attributes(element, [kAXRoleAttribute, kAXSubroleAttribute, "AXHidden"])
            guard let role = string(identity.first), !AccessibleContextNode.isSecure(role: role, subrole: identity.count > 1 ? string(identity[1]) : nil),
                  !(identity.count > 2 && (identity[2] as? Bool) == true) else { continue }
            // Secure subtrees are rejected before requesting any value/text.
            let names = [kAXTitleAttribute, kAXDescriptionAttribute, kAXHelpAttribute,
                         kAXEnabledAttribute, kAXFocusedAttribute, kAXSelectedAttribute,
                         kAXExpandedAttribute, kAXPositionAttribute, kAXSizeAttribute]
            let values = attributes(element, names)
            guard values.count == names.count else { continue }
            let frame = rect(values, 7, 8)
            if let frame, frame.isEmpty || !frame.intersects(clip) { continue }
            let childClip = frame.map { clip.intersection($0) } ?? clip
            var nextParent = parent
            if let frame, let bounds = ContextRect(frame), !childClip.isEmpty {
                let label = string(values[0]) ?? string(values[1])
                var value: String?
                if !target.omitValues {
                    if ["AXTextField", "AXTextArea", "AXComboBox"].contains(role) {
                        // Request only the visible text range, not an editor's
                        // entire document or off-screen selected text.
                        if let rawRange = attribute(element, kAXVisibleCharacterRangeAttribute), CFGetTypeID(rawRange) == AXValueGetTypeID() {
                            var range = CFRange()
                            if AXValueGetValue(unsafeDowncast(rawRange, to: AXValue.self), .cfRange, &range), range.location >= 0, range.length > 0 {
                                range.length = min(range.length, 500)
                                let timeout = remaining()
                                if let argument = AXValueCreate(.cfRange, &range), timeout > 0 {
                                    AXUIElementSetMessagingTimeout(element, timeout)
                                    var text: CFTypeRef?
                                    if AXUIElementCopyParameterizedAttributeValue(element, kAXStringForRangeParameterizedAttribute as CFString, argument, &text) == .success { value = string(text) }
                                }
                            }
                        }
                    } else if ["AXStaticText", "AXCheckBox", "AXRadioButton", "AXSlider", "AXPopUpButton", "AXButton"].contains(role) {
                        let raw = attribute(element, kAXValueAttribute)
                        value = string(raw) ?? (raw as? NSNumber)?.stringValue
                    }
                }
                let id = result.nodes.count
                result.nodes.append(AccessibleContextNode(id: id, parent: parent, role: role, label: label, value: value,
                    help: string(values[2]), enabled: values[3] as? Bool, focused: values[4] as? Bool, selected: values[5] as? Bool,
                    expanded: values[6] as? Bool, bounds: ContextRect(childClip) ?? bounds))
                nextParent = id
            }
            guard depth < 16, remaining() > 0 else { result.truncated = true; continue }
            let childTimeout = remaining()
            guard childTimeout > 0 else { break }
            AXUIElementSetMessagingTimeout(element, childTimeout)
            var children: CFArray?
            if AXUIElementCopyAttributeValues(element, kAXChildrenAttribute as CFString, 0, 40, &children) == .success,
               let list = children as? [AXUIElement] {
                for child in list.reversed() { pending.append((child, nextParent, depth + 1, childClip)) }
                if list.count == 40 { result.truncated = true }
            }
        }
        result.truncated = result.truncated || !pending.isEmpty
        return result
    }
}

private extension CGRect { nonisolated var area: CGFloat { isNull ? 0 : width * height } }
extension ContextRect {
    nonisolated init?(_ rect: CGRect) { self.init(x: rect.minX, y: rect.minY, width: rect.width, height: rect.height) }
}
