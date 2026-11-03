import AppKit
import SwiftUI
import Observation
import ClickyCore

/// Voice-first companion. Settings open only through an explicit menu action.
@main @MainActor enum ClickyApp {
    private static let delegate = CompanionDelegate()
    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        app.delegate = delegate
        let menu = NSMenu()
        let application = NSMenuItem()
        application.submenu = NSMenu()
        application.submenu?.addItem(withTitle: "Quit Clicky", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(application)
        let edit = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
        edit.submenu = NSMenu(title: "Edit")
        edit.submenu?.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.submenu?.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.submenu?.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.submenu?.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        menu.addItem(edit)
        app.mainMenu = menu
        app.run()
    }
}

final class CompanionDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, NSMenuDelegate {
    let model = CompanionModel()
    private var notch: NotchPanel?
    private var visualWindow: VisualWindowController?
    private var terminationHandler: DispatchSourceSignal?
    private var settingsPanel: CompanionSettingsPanel?
    private var statusItem: NSStatusItem?
    private var previousApplication: NSRunningApplication?

    func applicationDidFinishLaunching(_ notification: Notification) {
        signal(SIGTERM, SIG_IGN)
        let termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        termination.setEventHandler { NSApp.terminate(nil) }
        termination.resume(); terminationHandler = termination
        model.desktop.rememberContextApplication(NSWorkspace.shared.frontmostApplication)
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(contextApplicationActivated(_:)), name: NSWorkspace.didActivateApplicationNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(screenChanged), name: NSApplication.didChangeScreenParametersNotification, object: nil)
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(screenChanged), name: NSWorkspace.activeSpaceDidChangeNotification, object: nil)
        if let flag = CommandLine.arguments.firstIndex(of: "--import-elevenlabs-key-file"), flag + 1 < CommandLine.arguments.count {
            let url = URL(fileURLWithPath: CommandLine.arguments[flag + 1])
            do {
                defer { try? FileManager.default.removeItem(at: url) }
                try VoiceKeychain.save(String(contentsOf: url, encoding: .utf8))
            } catch { model.error = "Could not import the voice key. " + error.localizedDescription }
        }
        let notch = NotchPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        notch.title = "Clicky status"
        notch.isOpaque = false; notch.backgroundColor = .clear; notch.hasShadow = false
        notch.ignoresMouseEvents = true
        notch.hidesOnDeactivate = false
        notch.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        notch.contentView = NSHostingView(rootView: PassiveStatusView(model: model))
        self.notch = notch
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.image = NSImage(systemSymbolName: "cursorarrow.rays", accessibilityDescription: "Clicky for BB")
        item.menu = NSMenu()
        item.menu?.delegate = self
        statusItem = item
        NotificationCenter.default.addObserver(self, selector: #selector(contextPermissionsChanged), name: NSApplication.didBecomeActiveNotification, object: nil)
        observeStatus()
        do {
            try model.desktop.registerShortcut(action: { [weak self] in
                self?.model.dismissVisuals()
                self?.model.error = nil
                Task { await self?.model.stop() }
            }, onVoicePress: { [weak self] in
                self?.model.desktop.rememberContextApplication(NSWorkspace.shared.frontmostApplication)
                Task { await self?.model.beginRecording() }
            }, onVoiceRelease: { [weak self] in Task { await self?.model.endRecording() } })
        } catch { model.error = error.localizedDescription }
        let visuals = VisualWindowController(model: model)
        visualWindow = visuals
        model.onVisualPresentation = { [weak visuals] in visuals?.present() }
        model.onVisualDismiss = { [weak visuals] in visuals?.close() }
        Task { await model.connect() }
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        func add(_ title: String, _ action: Selector, represented: String? = nil) {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
            item.target = self; item.representedObject = represented; menu.addItem(item)
        }
        add(model.recording || model.requestingMicrophone ? "Finish question" : "Ask by voice", #selector(toggleListening))
        add("Stop latest request and speech", #selector(stopRequest))
        add("Clear drawing", #selector(clearDrawing))
        for request in model.pendingApprovals {
            add("Approve in BB: " + request.title, #selector(openRequest(_:)), represented: request.id)
        }
        if let request = model.currentRequest, request.threadID != nil {
            add("Open latest request in BB", #selector(openRequest(_:)), represented: request.id)
        }
        if let error = model.error { menu.addItem(NSMenuItem(title: String(error.prefix(180)), action: nil, keyEquivalent: "")) }
        menu.addItem(.separator())
        add("Settings…", #selector(showSettings)); add("Quit Clicky", #selector(quit))
    }
    @objc private func toggleListening() {
        guard !model.transcribing else { return }
        model.desktop.rememberContextApplication(NSWorkspace.shared.frontmostApplication)
        Task { if model.recording || model.requestingMicrophone { await model.endRecording() } else { await model.beginRecording() } }
    }
    @objc private func stopRequest() { model.error = nil; Task { await model.stop() } }
    @objc private func clearDrawing() { model.dismissVisuals() }
    @objc private func openRequest(_ item: NSMenuItem) {
        Task { await model.openInBB(requestID: item.representedObject as? String) }
    }
    @objc private func quit() { NSApp.terminate(nil) }

    @objc private func showSettings() {
        if let front = NSWorkspace.shared.frontmostApplication, front.processIdentifier != ProcessInfo.processInfo.processIdentifier {
            previousApplication = front
            model.desktop.rememberContextApplication(front)
        }
        if settingsPanel == nil {
            let panel = CompanionSettingsPanel(contentRect: NSRect(x: 0, y: 0, width: 650, height: 610),
                styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
            panel.title = "Clicky settings"
            panel.isReleasedWhenClosed = false
            panel.hidesOnDeactivate = false
            panel.minSize = NSSize(width: 570, height: 430)
            panel.appearance = NSAppearance(named: .darkAqua)
            panel.backgroundColor = NSColor(red: 24/255, green: 24/255, blue: 24/255, alpha: 1)
            panel.contentView = NSHostingView(rootView: CompanionSettingsView(model: model, hide: { [weak self] in self?.hideSettings() }))
            panel.delegate = self
            if !panel.setFrameUsingName("ClickySettings") { panel.center() }
            panel.setFrameAutosaveName("ClickySettings")
            settingsPanel = panel
        }
        model.refreshContextPermissions()
        settingsPanel?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
    private func hideSettings() {
        model.save()
        settingsPanel?.orderOut(nil)
        if NSApp.isActive, let previousApplication, !previousApplication.isTerminated { previousApplication.activate() }
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool { hideSettings(); return false }
    @objc private func contextPermissionsChanged() {
        if settingsPanel?.isVisible == true { model.refreshContextPermissions() }
    }

    @objc private func contextApplicationActivated(_ notification: Notification) {
        model.desktop.rememberContextApplication(notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)
    }
    @objc private func screenChanged() { positionStatus() }
    private func observeStatus() {
        _ = withObservationTracking { model.statusActive } onChange: { [weak self] in
            Task { @MainActor in self?.observeStatus() }
        }
        positionStatus()
    }
    private func positionStatus() {
        guard let screen = NotchPlacement.screen else { notch?.orderOut(nil); return }
        guard model.statusActive else { notch?.orderOut(nil); return }
        let placement = NotchPlacement(screen: screen, expanded: true)
        notch?.level = placement.cutoutWidth > 0 ? .statusBar : .floating
        notch?.setFrame(placement.frame, display: true)
        notch?.orderFrontRegardless()
    }
    func applicationWillTerminate(_ notification: Notification) { model.shutdown() }
}

extension CompanionModel {
    var statusActive: Bool {
        recording || requestingMicrophone || transcribing || voice.speaking || error != nil || visualWarning != nil
            || currentRequest?.retired == false && currentRequest?.phase.busy == true || !pendingApprovals.isEmpty
    }
    var statusText: String {
        if requestingMicrophone { return "Connecting voice…" }
        if recording { return "Listening…" }
        if transcribing { return "Transcribing…" }
        if voice.speaking { return "Speaking…" }
        if !pendingApprovals.isEmpty { return "Approval needed in BB" }
        if let error { return error }
        if let visualWarning { return visualWarning }
        return currentRequest?.phase.label ?? "Clicky"
    }
}

private struct PassiveStatusView: View {
    @Bindable var model: CompanionModel
    var body: some View {
        let cutout = NotchPlacement.screen.map { NotchPlacement(screen: $0).cutoutWidth } ?? 0
        HStack(spacing: 0) {
            Text(model.statusText).lineLimit(1).frame(maxWidth: .infinity)
            if cutout > 0 { Color.clear.frame(width: cutout) }
            Text("⌃ ⌥ Space").foregroundStyle(.secondary).frame(maxWidth: .infinity)
        }.font(.system(size: 11, weight: .medium))
            .foregroundStyle(.white).frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(.black, in: UnevenRoundedRectangle(bottomLeadingRadius: 12, bottomTrailingRadius: 12))
            .allowsHitTesting(false)
    }
}

private final class CompanionSettingsPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

// These colors mirror bb Monokai's background, foreground, cyan, and purple palette.
private enum Palette {
    static let accent = Color(red: 81/255, green: 218/255, blue: 233/255)
}

private struct CompanionSettingsView: View {
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
                        Button("Save key") {
                            let key = voiceKeyDraft; voiceKeyDraft = ""
                            Task { await model.saveVoiceKey(key) }
                        }.disabled(voiceKeyDraft.isEmpty || model.voiceKeyBusy)
                        Button("Check key") { Task { await model.checkVoiceKey() } }.disabled(model.voiceKeyBusy)
                        Button("Remove key") { Task { await model.removeVoiceKey() } }.disabled(model.voiceKeyBusy)
                    }
                    Text(model.voiceKeyBusy ? "Waiting for Keychain…" : model.voiceKeyStatus).font(.caption).foregroundStyle(.secondary)
                    field("Voice ID", text: Binding(get: { model.preferences.elevenLabsVoiceID ?? RealtimeVoiceProtocol.defaultVoiceID },
                        set: { model.preferences.elevenLabsVoiceID = $0.isEmpty ? nil : $0 }))
                    Text("Voice questions get spoken replies. Hold to interrupt speech; release to send. Each hold automatically sends at 30 seconds. Only the beginning of long replies is read aloud.").font(.caption).foregroundStyle(.secondary)
                }.padding(18).background(.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 12))
                Text("Hold ⌃ ⌥ Space to talk; release to ask. ⌘ ⇧ Space stops the latest request and clears graphics. Every question starts a fresh BB request with recent context. There are no conversations to manage. BB retains prompts and attachments. ElevenLabs receives microphone audio and spoken reply text. Your key stays in Keychain.")
                    .font(.caption).foregroundStyle(.secondary).lineSpacing(4)
                Text("For a remote BB connection, enter its authenticated local proxy URL. If BB’s host daemon restarts, that URL may change; update it here and check the connection again.").font(.caption).foregroundStyle(.secondary)
                Text("Agents use BB’s approval flow. When a task needs permission, choose its approval entry from the menu to continue in BB.").font(.caption).foregroundStyle(.secondary)
                if let error = model.error { Text(error).font(.caption).foregroundStyle(.orange) }
                HStack {
                    Button("Done", action: hide)
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
