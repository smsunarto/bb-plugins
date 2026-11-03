import AppKit
import Carbon
import ClickyCore
import ScreenCaptureKit

@MainActor struct CapturedScreen {
    let url: URL
    let image: NSImage
    let displayID: CGDirectDisplayID
    let frame: CGRect
    let capturedAt: Date
}

enum DesktopServiceError: LocalizedError {
    case microphoneDenied
    case screenCaptureDenied
    case displayUnavailable
    case imageEncodingFailed
    case shortcutUnavailable(OSStatus)

    var errorDescription: String? {
        switch self {
        case .microphoneDenied:
            "Allow microphone access for Clicky in System Settings → Privacy & Security → Microphone."
        case .screenCaptureDenied:
            "Allow Clicky in System Settings → Privacy & Security → Screen & System Audio Recording, then reopen the app."
        case .displayUnavailable: "The selected display is no longer connected. Capture your screen again."
        case .imageEncodingFailed: "The screenshot could not be saved."
        case let .shortcutUnavailable(status):
            "Clicky's shortcut could not be registered (\(status)). Resolve the conflicting shortcut, then relaunch Clicky."
        }
    }
}

/// Owns native resources; captures never leave the Mac through this service.
@MainActor
final class DesktopServices {
    private(set) var contextApplication: ContextApplication?
    private var overlay: NSPanel?
    private var overlayExpiry: Task<Void, Never>?
    private var hotKeys: [EventHotKeyRef] = []
    private var eventHandler: EventHandlerRef?
    private var toggleAction: (@MainActor () -> Void)?
    private var voicePressAction: (@MainActor () -> Void)?
    private var voiceReleaseAction: (@MainActor () -> Void)?
    private var panelKeyDown = false
    private var voiceKeyDown = false
    private let temporaryDirectory = FileManager.default.temporaryDirectory
        .appendingPathComponent("bb-clicky-\(UUID().uuidString)", isDirectory: true)

    func rememberContextApplication(_ app: NSRunningApplication?) {
        guard let app, app.processIdentifier != ProcessInfo.processInfo.processIdentifier else { return }
        contextApplication = ContextApplication(pid: app.processIdentifier, name: app.localizedName ?? "Unknown app", bundleID: app.bundleIdentifier,
            omitValues: IsSecureEventInputEnabled())
    }

    /// Manual capture permits the OS prompt; automatic initial context never prompts.
    func captureScreen(displayID requestedDisplay: CGDirectDisplayID? = nil, requestPermission: Bool = true) async throws -> CapturedScreen {
        clearPoints()
        guard let screen = requestedDisplay.flatMap({ id in NSScreen.screens.first { ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == id } })
                ?? (requestedDisplay == nil ? (NSScreen.screens.first(where: { $0.frame.contains(NSEvent.mouseLocation) }) ?? NSScreen.main) : nil),
              let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else {
            throw DesktopServiceError.displayUnavailable
        }
        let displayID = number.uint32Value
        let frame = screen.frame
        guard CGPreflightScreenCaptureAccess() || (requestPermission && CGRequestScreenCaptureAccess()) else {
            throw DesktopServiceError.screenCaptureDenied
        }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        try Task.checkCancellation()
        guard let display = content.displays.first(where: { $0.displayID == displayID }) else {
            throw DesktopServiceError.displayUnavailable
        }
        let ownApplications = content.applications.filter { $0.processID == ProcessInfo.processInfo.processIdentifier }
        let filter = SCContentFilter(display: display, excludingApplications: ownApplications, exceptingWindows: [])
        if #available(macOS 14.2, *) { filter.includeMenuBar = true }
        let configuration = SCStreamConfiguration()
        let scale = min(1, 1600 / Double(max(display.width, display.height)))
        configuration.width = max(1, Int(Double(display.width) * scale))
        configuration.height = max(1, Int(Double(display.height) * scale))
        configuration.showsCursor = false
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
        try Task.checkCancellation()
        guard let data = NSBitmapImageRep(cgImage: image).representation(using: .jpeg, properties: [.compressionFactor: 0.82]) else {
            throw DesktopServiceError.imageEncodingFailed
        }
        let url = try temporaryFile(extension: "jpg")
        try data.write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        return CapturedScreen(
            url: url,
            image: NSImage(cgImage: image, size: NSSize(width: image.width, height: image.height)),
            displayID: displayID,
            frame: frame,
            capturedAt: Date()
        )
    }

    func discardCapture(_ capture: CapturedScreen) {
        try? FileManager.default.removeItem(at: capture.url)
    }

    /// Explicit UI action only: a captured screen may be stale by the time the answer arrives.
    func showPoints(in response: String, for capture: CapturedScreen) {
        clearPoints()
        guard let screen = NSScreen.screens.first(where: {
            ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == capture.displayID
        }), screen.frame == capture.frame else { return }
        let points = ScreenPoint.parse(in: response).points
        guard !points.isEmpty else { return }
        let panel = NSPanel(contentRect: capture.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        panel.isReleasedWhenClosed = false
        panel.contentView = ScreenPointView(frame: CGRect(origin: .zero, size: capture.frame.size), points: points)
        panel.orderFrontRegardless()
        overlay = panel
        overlayExpiry = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(8)) } catch { return }
            self?.clearPoints()
        }
    }

    func clearPoints() {
        overlayExpiry?.cancel()
        overlayExpiry = nil
        overlay?.orderOut(nil)
        overlay?.close()
        overlay = nil
    }

    /// Cmd+Shift+Space toggles the panel; hold Control+Option+Space for voice.
    func registerShortcut(
        action: @escaping @MainActor () -> Void,
        onVoicePress: (@MainActor () -> Void)? = nil,
        onVoiceRelease: (@MainActor () -> Void)? = nil
    ) throws {
        unregisterShortcuts()
        toggleAction = action
        voicePressAction = onVoicePress
        voiceReleaseAction = onVoiceRelease
        var types = [
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed)),
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyReleased)),
        ]
        let installStatus = InstallEventHandler(
            GetApplicationEventTarget(), clickyHotKeyHandler, types.count, &types,
            Unmanaged.passUnretained(self).toOpaque(), &eventHandler
        )
        guard installStatus == noErr else {
            unregisterShortcuts()
            throw DesktopServiceError.shortcutUnavailable(installStatus)
        }
        for (key, modifiers, id) in [(kVK_Space, cmdKey | shiftKey, UInt32(1)), (kVK_Space, controlKey | optionKey, UInt32(2))] {
            var reference: EventHotKeyRef?
            let status = RegisterEventHotKey(
                UInt32(key), UInt32(modifiers), EventHotKeyID(signature: 0x434C494B, id: id),
                GetApplicationEventTarget(), 0, &reference
            )
            guard status == noErr, let reference else {
                unregisterShortcuts()
                throw DesktopServiceError.shortcutUnavailable(status)
            }
            hotKeys.append(reference)
        }
    }

    fileprivate func handleHotKey(id: UInt32, pressed: Bool) {
        if id == 1, pressed, !panelKeyDown {
            panelKeyDown = true
            toggleAction?()
        } else if id == 1, !pressed {
            panelKeyDown = false
        }
        if id == 2, pressed, !voiceKeyDown {
            voiceKeyDown = true
            voicePressAction?()
        } else if id == 2, !pressed, voiceKeyDown {
            voiceKeyDown = false
            voiceReleaseAction?()
        }
    }

    func shutdown() {
        clearPoints()
        unregisterShortcuts()
        try? FileManager.default.removeItem(at: temporaryDirectory)
    }

    private func unregisterShortcuts() {
        for key in hotKeys { UnregisterEventHotKey(key) }
        hotKeys.removeAll()
        if let eventHandler { RemoveEventHandler(eventHandler) }
        eventHandler = nil
        toggleAction = nil
        voicePressAction = nil
        voiceReleaseAction = nil
        panelKeyDown = false
        voiceKeyDown = false
    }

    private func temporaryFile(extension suffix: String) throws -> URL {
        try FileManager.default.createDirectory(at: temporaryDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        return temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathExtension(suffix)
    }

    isolated deinit {
        shutdown()
    }
}

nonisolated private func clickyHotKeyHandler(
    _: EventHandlerCallRef?, event: EventRef?, context: UnsafeMutableRawPointer?
) -> OSStatus {
    guard let event, let context, Thread.isMainThread else { return OSStatus(eventNotHandledErr) }
    var hotKeyID = EventHotKeyID()
    let status = GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil, MemoryLayout<EventHotKeyID>.size, nil, &hotKeyID)
    guard status == noErr, hotKeyID.signature == 0x434C494B else { return OSStatus(eventNotHandledErr) }
    let owner = Unmanaged<DesktopServices>.fromOpaque(context).takeUnretainedValue()
    let id = hotKeyID.id
    let pressed = GetEventKind(event) == UInt32(kEventHotKeyPressed)
    MainActor.assumeIsolated {
        owner.handleHotKey(id: id, pressed: pressed)
    }
    return noErr
}

@MainActor
private final class ScreenPointView: NSView {
    let points: [ScreenPoint]

    init(frame: CGRect, points: [ScreenPoint]) {
        self.points = points
        super.init(frame: frame)
    }

    required init?(coder: NSCoder) { nil }

    override func draw(_ dirtyRect: NSRect) {
        for point in points {
            let position = point.position(width: Double(bounds.width), height: Double(bounds.height), originX: Double(bounds.minX), originY: Double(bounds.minY))
            let location = CGPoint(x: position.x, y: position.y)
            let circle = NSBezierPath(ovalIn: CGRect(x: location.x - 20, y: location.y - 20, width: 40, height: 40))
            NSColor.controlAccentColor.withAlphaComponent(0.18).setFill()
            circle.fill()
            NSColor.controlAccentColor.setStroke()
            circle.lineWidth = 3
            circle.stroke()

            let attributes: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 14, weight: .semibold), .foregroundColor: NSColor.labelColor]
            let label = point.label as NSString
            let size = label.size(withAttributes: attributes)
            let width = min(size.width + 20, bounds.width)
            let x = min(max(0, location.x - width / 2), bounds.width - width)
            let y = min(max(0, location.y - 50), bounds.height - 28)
            let box = CGRect(x: x, y: y, width: width, height: 28)
            NSColor.windowBackgroundColor.setFill()
            NSBezierPath(roundedRect: box, xRadius: 8, yRadius: 8).fill()
            label.draw(in: box.insetBy(dx: 10, dy: 5), withAttributes: attributes)
        }
    }
}
