import AppKit
import SwiftUI
import ClickyCore

@main struct ClickyApp: App {
    @NSApplicationDelegateAdaptor(CompanionDelegate.self) var delegate
    var body: some Scene { Settings { EmptyView() } }
}

final class CompanionPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

final class CompanionDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, NSMenuDelegate {
    let model = CompanionModel()
    private var panel: CompanionPanel?
    private var statusItem: NSStatusItem?
    private var notch: NSPanel?
    private var visualWindow: VisualWindowController?
    private var previousApplication: NSRunningApplication?
    private var positioningWindows = false
    private var notchHovered = false
    private var notchLayout: NotchLayoutState?

    func applicationDidFinishLaunching(_ notification: Notification) {
        model.desktop.rememberContextApplication(NSWorkspace.shared.frontmostApplication)
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(contextApplicationActivated(_:)), name: NSWorkspace.didActivateApplicationNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(contextPermissionsChanged), name: NSApplication.didBecomeActiveNotification, object: nil)
        NSApp.setActivationPolicy(.accessory)
        // Secure bootstrap: the key itself is never passed in argv or logged.
        if let flag = CommandLine.arguments.firstIndex(of: "--import-elevenlabs-key-file"), flag + 1 < CommandLine.arguments.count {
            let url = URL(fileURLWithPath: CommandLine.arguments[flag + 1])
            do {
                let key = try String(contentsOf: url, encoding: .utf8)
                defer { try? FileManager.default.removeItem(at: url) }
                try VoiceKeychain.save(key)
                model.voiceKeyStatus = "Key saved in Keychain"
            } catch { model.error = "Could not import the voice key. " + error.localizedDescription }
        }
        let panel = CompanionPanel(contentRect: NSRect(x: 0, y: 0, width: 820, height: 610), styleMask: [.titled, .closable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        panel.title = "Clicky for BB"
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.isMovableByWindowBackground = false
        panel.isMovable = false
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.minSize = NSSize(width: 570, height: 430)
        panel.backgroundColor = NSColor(red: 24/255, green: 24/255, blue: 24/255, alpha: 1)
        panel.appearance = NSAppearance(named: .darkAqua)
        panel.contentView = NSHostingView(rootView: CompanionView(model: model, hide: { [weak self] in self?.hide() }))
        panel.delegate = self
        if !panel.setFrameUsingName("ClickyPanel") {
            if let screen = NSScreen.main { panel.setFrameOrigin(NSPoint(x: screen.visibleFrame.midX - 410, y: screen.visibleFrame.maxY - 630)) }
        }
        if let screen = panel.screen ?? NSScreen.main {
            let bounds = screen.visibleFrame
            var frame = panel.frame
            frame.origin.x = min(max(frame.minX, bounds.minX), max(bounds.minX, bounds.maxX - frame.width))
            frame.origin.y = min(max(frame.minY, bounds.minY), max(bounds.minY, bounds.maxY - frame.height))
            panel.setFrame(frame, display: false)
        }
        panel.setFrameAutosaveName("ClickyPanel")
        self.panel = panel
        let notch = NotchPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        notch.title = "Clicky notch"
        notch.level = .statusBar
        notch.isOpaque = false
        notch.backgroundColor = .clear
        notch.hasShadow = false
        notch.hidesOnDeactivate = false
        notch.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        self.notch = notch
        positionWindows()
        NotificationCenter.default.addObserver(self, selector: #selector(screenChanged), name: NSApplication.didChangeScreenParametersNotification, object: nil)
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(screenChanged), name: NSWorkspace.activeSpaceDidChangeNotification, object: nil)
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.image = NSImage(systemSymbolName: "cursorarrow.rays", accessibilityDescription: "Clicky for BB")
        item.button?.target = self
        item.menu = NSMenu()
        item.menu?.delegate = self
        statusItem = item
        do {
            try model.desktop.registerShortcut(action: { [weak self] in self?.toggleListening() }, onVoicePress: { [weak self] in
                self?.model.desktop.rememberContextApplication(NSWorkspace.shared.frontmostApplication)
                Task { await self?.model.beginRecording() }
            }, onVoiceRelease: { [weak self] in Task { await self?.model.endRecording() } })
        } catch { model.error = error.localizedDescription }
        let visualWindow = VisualWindowController(model: model)
        self.visualWindow = visualWindow
        model.onVisualPresentation = { [weak visualWindow] in
            visualWindow?.present()
        }
        model.onVisualDismiss = { [weak visualWindow] in visualWindow?.close() }
        model.panelVisible = false
        notch.orderFrontRegardless()
        Task { await model.connect() }
    }
    @objc func toggleListening() {
        guard !model.transcribing else { return }
        model.desktop.rememberContextApplication(NSWorkspace.shared.frontmostApplication)
        Task { if model.recording || model.requestingMicrophone { await model.endRecording() } else { await model.beginRecording() } }
    }
    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        func add(_ title: String, _ action: Selector, represented: String? = nil) {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: ""); item.target = self; item.representedObject = represented; menu.addItem(item)
        }
        add(model.recording ? "Finish question" : "Ask by voice", #selector(toggleListening))
        add("Stop latest request and speech", #selector(stopRequest))
        add("Clear drawing", #selector(clearDrawing))
        for request in model.pendingApprovals { add("Approve in BB: " + request.title, #selector(openRequest(_:)), represented: request.id) }
        if let request = model.currentRequest { add("Open latest request in BB", #selector(openRequest(_:)), represented: request.id) }
        if let error = model.error { let item = NSMenuItem(title: String(error.prefix(180)), action: nil, keyEquivalent: ""); menu.addItem(item) }
        menu.addItem(.separator())
        add("Settings…", #selector(show)); add("Quit Clicky", #selector(quit))
    }
    @objc private func stopRequest() { Task { await model.stop() } }
    @objc private func clearDrawing() { model.dismissVisuals(); model.stopSpeaking(); model.desktop.clearPoints() }
    @objc private func openRequest(_ item: NSMenuItem) { Task { await model.openInBB(requestID: item.representedObject as? String) } }
    @objc private func quit() { NSApp.terminate(nil) }
    @objc func show() {
        if let front = NSWorkspace.shared.frontmostApplication, front.processIdentifier != ProcessInfo.processInfo.processIdentifier {
            previousApplication = front
            model.desktop.rememberContextApplication(front)
        }
        model.panelVisible = true
        positionWindows()
        notch?.orderFrontRegardless()
        Task { await model.refresh() }
        panel?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
    func hide() {
        model.panelVisible = false; model.desktop.clearPoints(); panel?.orderOut(nil)
        if NSApp.isActive, let previousApplication, !previousApplication.isTerminated { previousApplication.activate() }
        positionWindows()
        notch?.orderFrontRegardless()
    }
    @objc private func contextApplicationActivated(_ notification: Notification) {
        model.desktop.rememberContextApplication(notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)
    }
    @objc private func contextPermissionsChanged() { model.refreshContextPermissions() }
    @objc private func screenChanged() { positionWindows() }
    func windowDidEndLiveResize(_ notification: Notification) { positionWindows() }
    private func positionWindows() {
        guard !positioningWindows, let screen = NotchPlacement.screen else { return }
        positioningWindows = true
        defer { positioningWindows = false }
        let active = model.recording || model.requestingMicrophone || model.transcribing || model.voice.speaking || model.error != nil || model.visualWarning != nil || model.visualDocument != nil || model.currentRequest?.retired == false && model.currentRequest?.phase.busy == true || !model.pendingApprovals.isEmpty
        let placement = NotchPlacement(screen: screen, expanded: notchHovered || model.panelVisible || active)
        notch?.level = placement.cutoutWidth > 0 ? .statusBar : .floating
        notch?.setFrame(placement.frame, display: true)
        if let notchLayout {
            if notchLayout.placement != placement { notchLayout.placement = placement }
        } else {
            let layout = NotchLayoutState(placement: placement)
            notchLayout = layout
            let hosting = NotchHostingView(rootView: AnyView(NotchView(model: model, layout: layout,
                open: { [weak self] in self?.toggleListening() }, activityChanged: { [weak self] in self?.positionWindows() })))
            hosting.sizingOptions = []
            hosting.hoverChanged = { [weak self] hovered in
                guard let self, self.notchHovered != hovered else { return }
                self.notchHovered = hovered
                self.positionWindows()
            }
            notch?.contentView = hosting
        }
        if let panel {
            panel.setFrame(placement.expandedFrame(size: panel.frame.size, visibleFrame: screen.visibleFrame), display: true)
        }
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool { hide(); return false }
    func applicationWillTerminate(_ notification: Notification) { model.shutdown() }
}

private final class NotchLayoutState: ObservableObject {
    @Published var placement: NotchPlacement
    init(placement: NotchPlacement) { self.placement = placement }
}

private final class NotchHostingView: NSHostingView<AnyView> {
    var hoverChanged: ((Bool) -> Void)?
    private var hoverArea: NSTrackingArea?
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let hoverArea { removeTrackingArea(hoverArea) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self)
        addTrackingArea(area)
        hoverArea = area
    }
    override func mouseEntered(with event: NSEvent) { hoverChanged?(true) }
    override func mouseExited(with event: NSEvent) { hoverChanged?(false) }
    override var isOpaque: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

private struct NotchView: View {
    @Bindable var model: CompanionModel
    @ObservedObject var layout: NotchLayoutState
    let open: () -> Void
    let activityChanged: () -> Void
    private var placement: NotchPlacement { layout.placement }
    private var active: Bool { model.recording || model.requestingMicrophone || model.transcribing || model.voice.speaking || model.error != nil || model.visualWarning != nil || model.visualDocument != nil || model.currentRequest?.retired == false && model.currentRequest?.phase.busy == true || !model.pendingApprovals.isEmpty }
    private var status: String {
        if model.requestingMicrophone { return "Connecting voice…" }
        if model.recording { return "Listening…" }
        if model.voice.speaking { return "Speaking…" }
        if model.transcribing { return "Transcribing…" }
        if !model.pendingApprovals.isEmpty { return "Approval in BB" }
        if model.error != nil || model.visualWarning != nil { return "Needs attention" }
        if model.currentRequest?.retired == false && model.currentRequest?.phase.busy == true || !model.pendingApprovals.isEmpty { return model.currentRequest?.phase.label ?? "Thinking…" }
        return "Clicky"
    }
    var body: some View {
        Group {
            if placement.cutoutWidth > 0 && placement.wingWidth == 0 {
                Button(action: open) {
                    Color.black.frame(width: placement.cutoutWidth, height: placement.frame.height)
                        .clipShape(UnevenRoundedRectangle(bottomLeadingRadius: 8, bottomTrailingRadius: 8))
                }.buttonStyle(.plain).accessibilityLabel("Ask Clicky")
            } else { controls }
        }.onChange(of: active) { _, _ in activityChanged() }
    }
    private var controls: some View {
        HStack(spacing: 0) {
            Button(action: open) {
                HStack(spacing: 7) {
                    Image(systemName: model.recording ? "waveform" : "cursorarrow.rays").foregroundStyle(Palette.accent)
                    Text(status).font(.system(size: 11, weight: .medium)).lineLimit(1)
                }.frame(maxWidth: .infinity)
            }.buttonStyle(.plain).accessibilityLabel("Ask Clicky: \(status)")
                .help(model.error ?? model.visualWarning ?? "Hold ⌃⌥Space to ask. Menu bar for settings and approvals.")
                .frame(width: placement.wingWidth > 0 ? placement.wingWidth : 150)
            if placement.cutoutWidth > 0 { Color.clear.frame(width: placement.cutoutWidth).allowsHitTesting(false) }
            HStack {
                if model.visualDocument != nil {
                    Button { model.dismissVisuals() } label: { Image(systemName: "xmark") }
                        .buttonStyle(.plain).help("Clear drawing").accessibilityLabel("Clear drawing")
                } else {
                    Button(action: open) { Text("⌃ ⌥ Space").font(.system(size: 10)).foregroundStyle(.secondary) }
                        .buttonStyle(.plain).accessibilityLabel("Ask Clicky")
                }
            }.frame(width: placement.wingWidth > 0 ? placement.wingWidth : 140)
        }.frame(height: placement.rowHeight)
            .padding(.bottom, placement.frame.height - placement.rowHeight)
            .background(.black, in: UnevenRoundedRectangle(bottomLeadingRadius: 12, bottomTrailingRadius: 12))
            .foregroundStyle(.white).preferredColorScheme(.dark)
    }
}

// These colors mirror bb Monokai's background, foreground, cyan, and purple palette.
private enum Palette {
    static let background = Color(red: 24/255, green: 24/255, blue: 24/255)
    static let foreground = Color(red: 227/255, green: 227/255, blue: 221/255)
    static let accent = Color(red: 81/255, green: 218/255, blue: 233/255)
    static let purple = Color(red: 168/255, green: 149/255, blue: 254/255)
}

struct CompanionView: View {
    @Bindable var model: CompanionModel
    var hide: () -> Void
    @State private var voiceKeyDraft = ""
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("Clicky settings").font(.system(size: 26, weight: .medium, design: .rounded))
                Text("Connect to your existing BB. Every question runs as a fresh BB request on the machine you choose.").font(.callout).foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 14) {
                    field("BB executable", text: $model.preferences.executable)
                    field("JavaScript runtime (blank for standalone CLI)", text: Binding(get: { model.preferences.runtimeExecutable ?? "" }, set: { model.preferences.runtimeExecutable = $0.isEmpty ? nil : $0 }))
                    field("BB server URL", text: $model.preferences.serverURL)
                    HStack {
                        Button(model.connecting ? "Connecting…" : "Check connection") { Task { await model.connect() } }.disabled(model.connecting)
                        if model.connected { Label("Connected", systemImage: "checkmark.circle.fill").foregroundStyle(Palette.accent).font(.caption) }
                    }
                    Picker("Run agents on", selection: $model.preferences.hostID) {
                        Text("Choose a machine").tag("")
                        ForEach(model.hosts, id: \.id) { host in Text(host.name).tag(host.id) }
                    }
                    Divider()
                    Text("Automatic context").font(.headline)
                    Toggle("Include current window text and its display with each question", isOn: Binding(get: { model.preferences.includeInitialContext ?? true }, set: { model.preferences.includeInitialContext = $0 }))
                    Text("Each question includes a fresh screenshot of the active window’s display, readable window context, and up to five prior interactions from the last ten minutes. BB saves the injected prompt and image.").font(.caption).foregroundStyle(.secondary)
                    HStack {
                        Button(model.accessibilityAllowed ? "Accessibility enabled" : "Enable Accessibility") { model.requestAccessibility() }
                        Button(model.screenCaptureAllowed ? "Screen Recording enabled" : "Enable Screen Recording") { model.requestScreenCapture() }
                    }
                    Text("If permissions still show as missing after rebuilding, remove and re-add the updated Clicky app in System Settings → Privacy & Security.").font(.caption).foregroundStyle(.secondary)
                    Divider()
                    Text("ElevenLabs realtime voice").font(.headline)
                    SecureField("ElevenLabs API key", text: $voiceKeyDraft).textFieldStyle(.roundedBorder)
                    HStack {
                        Button("Save key") { model.saveVoiceKey(voiceKeyDraft); voiceKeyDraft = "" }.disabled(voiceKeyDraft.isEmpty)
                        Button("Check key") { model.checkVoiceKey() }
                        Button("Remove key") { model.removeVoiceKey() }
                    }
                    Text(model.voiceKeyStatus).font(.caption).foregroundStyle(.secondary)
                    field("Voice ID", text: Binding(get: { model.preferences.elevenLabsVoiceID ?? RealtimeVoiceProtocol.defaultVoiceID },
                        set: { model.preferences.elevenLabsVoiceID = $0.isEmpty ? nil : $0 }))
                                        Text("Voice questions get spoken replies. Hold to interrupt speech; release to send. Each hold automatically sends at 30 seconds. Only the beginning of long replies is read aloud.").font(.caption).foregroundStyle(.secondary)
                }.padding(18).background(.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 12))
                Text("Hold ⌃ ⌥ Space to talk; release to ask. ⌘ ⇧ Space toggles listening. Every question starts a fresh BB request with recent context. There are no conversations to manage. BB retains prompts and attachments. ElevenLabs receives microphone audio and spoken reply text. Your key stays in Keychain.")
                    .font(.caption).foregroundStyle(.secondary).lineSpacing(4)
                Text("For a remote BB connection, enter its authenticated local proxy URL. If BB’s host daemon restarts, that URL may change; update it here and check the connection again.").font(.caption).foregroundStyle(.secondary)
                Text("Agents use BB’s approval flow. When a task needs permission, open its conversation in BB to continue.").font(.caption).foregroundStyle(.secondary)
                if let error = model.error { Text(error).font(.caption).foregroundStyle(.orange) }
                HStack {
                    Button("Done") { model.save(); hide() }.disabled(model.preferences.hostID.isEmpty || !model.connected)
                    Spacer()
                    Button("Quit Clicky") { NSApp.terminate(nil) }.buttonStyle(.plain).foregroundStyle(.secondary)
                }
            }.padding(30).frame(maxWidth: 650)
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
            .onChange(of: model.preferences.serverURL) { _, _ in model.connectionChanged() }
            .onChange(of: model.preferences.executable) { _, _ in model.connectionChanged() }
            .onChange(of: model.preferences.runtimeExecutable) { _, _ in model.connectionChanged() }
    }
    private func field(_ title: String, text: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 6) { Text(title).font(.caption); TextField(title, text: text).textFieldStyle(.roundedBorder) }
    }
}
