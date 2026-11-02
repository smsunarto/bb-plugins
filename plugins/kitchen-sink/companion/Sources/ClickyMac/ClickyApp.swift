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

final class CompanionDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    let model = CompanionModel()
    private var panel: CompanionPanel?
    private var statusItem: NSStatusItem?
    private var notch: NSPanel?
    private var visualWindow: VisualWindowController?
    private var previousApplication: NSRunningApplication?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        let panel = CompanionPanel(contentRect: NSRect(x: 0, y: 0, width: 820, height: 610), styleMask: [.titled, .closable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        panel.title = "Clicky for BB"
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.isMovableByWindowBackground = true
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
        let notch = VisualOutputPanel(contentRect: NSRect(x: 0, y: 0, width: 290, height: 40), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        notch.level = .floating
        notch.isOpaque = false
        notch.backgroundColor = .clear
        notch.hasShadow = true
        notch.hidesOnDeactivate = false
        notch.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        notch.contentView = NotchHostingView(rootView: AnyView(NotchView(model: model, open: { [weak self] in self?.show() })))
        self.notch = notch
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.image = NSImage(systemSymbolName: "cursorarrow.rays", accessibilityDescription: "Clicky for BB")
        item.button?.target = self
        item.button?.action = #selector(toggle)
        statusItem = item
        do {
            try model.desktop.registerShortcut(action: { [weak self] in self?.toggle() }, onVoicePress: { [weak self] in
                self?.hide(); Task { await self?.model.beginRecording(autoSend: true) }
            }, onVoiceRelease: { [weak self] in Task { await self?.model.endRecording() } })
        } catch { model.error = error.localizedDescription }
        let visualWindow = VisualWindowController(model: model)
        self.visualWindow = visualWindow
        model.onVisualPresentation = { [weak self, weak visualWindow] in
            if visualWindow?.isPresented != true { self?.hide() }
            visualWindow?.present()
        }
        model.onVisualDismiss = { [weak visualWindow] in visualWindow?.close() }
        if model.settingsVisible { show() } else { hide() }
        Task { await model.connect() }
    }
    @objc func toggle() { if panel?.isVisible == true { hide() } else { show() } }
    func show() {
        if let front = NSWorkspace.shared.frontmostApplication, front.processIdentifier != ProcessInfo.processInfo.processIdentifier { previousApplication = front }
        notch?.orderOut(nil); model.panelVisible = true; Task { await model.refresh() }; panel?.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
    func hide() {
        model.panelVisible = false; model.desktop.clearPoints(); panel?.orderOut(nil)
        if NSApp.isActive, let previousApplication, !previousApplication.isTerminated { previousApplication.activate() }
        if let screen = NSScreen.main {
            notch?.setFrameOrigin(NSPoint(x: screen.frame.midX - 145, y: screen.visibleFrame.maxY - 40))
            notch?.orderFrontRegardless()
        }
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool { hide(); return false }
    func applicationWillTerminate(_ notification: Notification) { model.shutdown() }
}

private final class NotchHostingView: NSHostingView<AnyView> {
    override var isOpaque: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

private struct NotchView: View {
    @Bindable var model: CompanionModel
    let open: () -> Void
    private var status: String {
        if model.recording { return "Listening…" }
        if model.transcribing { return "Transcribing…" }
        if model.error != nil || model.visualWarning != nil { return "Needs attention" }
        if model.selected?.phase.busy == true { return model.selected?.phase.label ?? "Thinking…" }
        return "Clicky"
    }
    var body: some View {
        HStack(spacing: 12) {
            Button(action: open) {
                HStack(spacing: 9) {
                    Image(systemName: model.recording ? "waveform" : "cursorarrow.rays").foregroundStyle(Palette.accent)
                    Text(status).font(.system(size: 12, weight: .medium)).lineLimit(1)
                    Spacer(minLength: 0)
                }
            }.buttonStyle(.plain).accessibilityLabel("Open Clicky: \(status)")
                .help(model.error ?? model.visualWarning ?? "Open conversation and settings")
            if model.visualDocument != nil {
                Button { model.dismissVisuals() } label: { Image(systemName: "xmark") }
                    .buttonStyle(.plain).help("Clear drawing").accessibilityLabel("Clear drawing")
            } else {
                Text("⌃ ⌥ Space").font(.system(size: 10)).foregroundStyle(.secondary)
            }
        }.padding(.horizontal, 20).frame(width: 290, height: 40)
            .background(.black, in: UnevenRoundedRectangle(bottomLeadingRadius: 16, bottomTrailingRadius: 16))
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
    @FocusState private var inputFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: "cursorarrow.rays").font(.title2).foregroundStyle(Palette.accent)
                Text("clicky").font(.system(size: 22, weight: .semibold, design: .rounded))
                Text("for BB").foregroundStyle(.secondary).font(.caption)
                Spacer()
                HStack(spacing: 5) {
                    Circle().fill(model.connected ? Palette.accent : .orange).frame(width: 6, height: 6)
                    Text(model.connected ? "Connected to BB" : "Offline").font(.caption).foregroundStyle(.secondary)
                }
                if model.canReopenVisual { Button("Show drawing") { hide(); model.openVisuals() }.buttonStyle(.plain).foregroundStyle(Palette.accent).disabled(model.sending) }
                iconButton("Settings", "gearshape") { model.settingsVisible.toggle() }.disabled(model.sending)
                iconButton("Hide companion", "minus") { hide() }
            }.padding(.horizontal, 22).padding(.top, 32).padding(.bottom, 18)
            Divider().opacity(0.4)
            if model.settingsVisible { settings }
            else {
                HStack(spacing: 0) {
                    sidebar.disabled(model.sending || model.recording || model.transcribing)
                    Divider().opacity(0.4)
                    VStack(spacing: 0) {
                        conversation
                        if let error = model.error ?? model.visualWarning { errorBanner(error) }
                        composer
                    }.frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
        }
        .foregroundStyle(Palette.foreground)
        .background(Palette.background)
        .tint(Palette.accent)
        .preferredColorScheme(.dark)
        .onAppear { inputFocused = true }
        .onChange(of: model.preferences.serverURL) { _, _ in model.connectionChanged() }
        .onChange(of: model.preferences.executable) { _, _ in model.connectionChanged() }
        .onChange(of: model.preferences.runtimeExecutable) { _, _ in model.connectionChanged() }
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 14) {
            Button { model.newConversation(); inputFocused = true } label: { Label("New conversation", systemImage: "plus.bubble").frame(maxWidth: .infinity, alignment: .leading) }
                .buttonStyle(.plain).padding(10).background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 9))
            Button { model.newConversation(job: true); inputFocused = true } label: { Label("Give an agent a job", systemImage: "sparkles").foregroundStyle(Palette.purple) }
                .buttonStyle(.plain).padding(.horizontal, 8)
            Text("YOUR CONVERSATIONS").font(.system(size: 9, weight: .semibold)).tracking(1.2).foregroundStyle(.secondary).padding(.top, 12)
            ScrollView {
                LazyVStack(spacing: 5) {
                    ForEach(model.visibleSessions) { session in
                        Button { model.select(session.id) } label: {
                            HStack(alignment: .top, spacing: 8) {
                                Image(systemName: session.isJob ? "sparkles" : "bubble.left").foregroundStyle(session.isJob ? Palette.purple : Palette.accent)
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(session.title).font(.system(size: 11, weight: .medium)).lineLimit(2)
                                    if session.phase != .ready { Text(session.phase.label).font(.system(size: 9)).foregroundStyle(.secondary).lineLimit(2) }
                                }
                                Spacer(minLength: 0)
                            }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
                                .background(model.selectedID == session.id ? .white.opacity(0.08) : .clear, in: RoundedRectangle(cornerRadius: 8))
                        }.buttonStyle(.plain)
                    }
                }
            }
            Spacer(minLength: 0)
            VStack(alignment: .leading, spacing: 5) {
                Text("⌘ ⇧ Space  ·  Show / hide")
                Text("Hold ⌃ ⌥ Space  ·  Talk")
            }.font(.system(size: 10)).foregroundStyle(.tertiary)
        }.padding(14).frame(width: 205).background(.black.opacity(0.12))
    }

    private var conversation: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if model.selected?.entries.isEmpty ?? true { welcome }
                    ForEach(model.selected?.entries ?? []) { entry in
                        VStack(alignment: .leading, spacing: 7) {
                            Text(entry.role == "user" ? "YOU" : "CLICKY").font(.system(size: 9, weight: .bold)).tracking(1.5).foregroundStyle(entry.role == "user" ? .secondary : Palette.accent)
                            Text((try? AttributedString(markdown: ScreenPoint.parse(in: entry.text).text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(ScreenPoint.parse(in: entry.text).text)).font(.system(size: 13)).lineSpacing(5).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                        }.padding(14).background(entry.role == "user" ? .white.opacity(0.045) : .clear, in: RoundedRectangle(cornerRadius: 12)).id(entry.id)
                    }
                    if let session = model.selected, session.phase != .ready {
                        HStack(spacing: 8) {
                            if session.phase == .running || session.phase == .sending { ProgressView().controlSize(.small) }
                            Text(session.phase.label).font(.caption).foregroundStyle(.secondary)
                            if session.phase == .needsApproval { Button("Open BB") { Task { await model.openInBB() } } }
                        }.padding(.horizontal, 14)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }.padding(22)
            }
            .onChange(of: model.selected?.entries.last?.text) { _, _ in proxy.scrollTo("bottom", anchor: .bottom) }
        }
    }
    private var welcome: some View {
        VStack(alignment: .leading, spacing: 18) {
            ZStack {
                Circle().fill(Palette.accent.opacity(0.10)).frame(width: 58, height: 58)
                Image(systemName: "cursorarrow.rays").font(.system(size: 29)).foregroundStyle(Palette.accent)
            }
            Text(model.selected?.isJob == true ? "What can I take off\nyour hands?" : "A little help,\nright where you are.")
                .font(.system(size: 29, weight: .medium, design: .rounded)).tracking(-0.7)
            Text(model.selected?.isJob == true ? "Describe a task. Your BB agent handles the work, and you can follow along here." : "Ask a question, talk it through, or share your screen. Your agents and tools are already in BB.")
                .font(.system(size: 13)).foregroundStyle(.secondary).lineSpacing(4).fixedSize(horizontal: false, vertical: true)
            VStack(alignment: .leading, spacing: 9) {
                suggestion("Help me understand what I’m looking at", symbol: "viewfinder")
                suggestion("Talk through an idea with me", symbol: "bubble.left.and.bubble.right")
            }.padding(.top, 8)
        }.padding(.vertical, 25).frame(maxWidth: .infinity, alignment: .leading)
    }
    private func suggestion(_ text: String, symbol: String) -> some View {
        Button { model.draft = text; inputFocused = true } label: {
            HStack { Image(systemName: symbol).foregroundStyle(Palette.accent); Text(text); Spacer(); Image(systemName: "arrow.up.left").foregroundStyle(.tertiary) }
                .font(.system(size: 11)).padding(12).background(.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 10))
        }.buttonStyle(.plain)
    }
    private var composer: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let capture = model.capture {
                HStack(spacing: 10) {
                    Image(nsImage: capture.image).resizable().scaledToFit().frame(width: 80, height: 50).clipShape(RoundedRectangle(cornerRadius: 5))
                    VStack(alignment: .leading) { Text("Screen attached").font(.caption); Text("Saved in your BB conversation when sent.").font(.system(size: 10)).foregroundStyle(.secondary) }
                    Spacer()
                    iconButton("Remove screenshot", "xmark") { model.clearCapture() }
                }.padding(8).background(.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
            }
            VStack(spacing: 12) {
                TextField(model.recording ? "Listening…" : model.transcribing ? "Transcribing with BB…" : "Ask anything, or give me a task…", text: $model.draft, axis: .vertical)
                    .textFieldStyle(.plain).font(.system(size: 13)).lineLimit(2...5).focused($inputFocused)
                    .disabled(model.sending)
                    .onSubmit { if model.canSend { Task { await model.send() } } }
                HStack(spacing: 12) {
                    iconButton(model.recording ? "Finish recording" : "Record voice", model.recording ? "stop.circle.fill" : "mic") {
                        Task { if model.recording { await model.endRecording() } else { await model.beginRecording() } }
                    }.foregroundStyle(model.recording ? .red : Palette.foreground).disabled(model.transcribing || model.sending)
                    iconButton("Capture screen", "viewfinder") { Task { await model.takeCapture() } }.disabled(model.capturing || model.sending)
                    iconButton("Stop speaking and clear guides", "speaker.slash") { model.desktop.stopSpeaking(); model.desktop.clearPoints() }
                    Spacer()
                    if model.hasGuides { iconButton("Show screen guides", "scope") { model.showGuides() } }
                    if model.selected?.threadID != nil { iconButton("Open conversation in BB", "arrow.up.forward.app") { Task { await model.openInBB() } } }
                    if model.selected?.phase.busy == true { iconButton("Stop agent", "stop.fill") { Task { await model.stop() } } }
                    Button { Task { await model.send() } } label: { Image(systemName: "arrow.up").font(.system(size: 14, weight: .bold)).frame(width: 30, height: 30) }
                        .buttonStyle(.plain).background(model.canSend ? Palette.accent : .white.opacity(0.1), in: RoundedRectangle(cornerRadius: 9)).foregroundStyle(model.canSend ? Palette.background : .secondary).disabled(!model.canSend).help("Send message").accessibilityLabel("Send message")
                }
            }.padding(14).background(.white.opacity(0.045), in: RoundedRectangle(cornerRadius: 14)).overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(.white.opacity(0.08)))
            HStack { Text("Powered by your BB agents"); Spacer(); if model.selected?.phase == .deliveryUnknown { Button("Refresh") { Task { await model.connect() } }.buttonStyle(.plain) } }
                .font(.system(size: 9)).foregroundStyle(.tertiary)
        }.padding(18)
    }

    private var settings: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("Make yourself at home.").font(.system(size: 26, weight: .medium, design: .rounded))
                Text("Connect to your existing BB. Conversations run in a personal workspace on the machine you choose.").font(.callout).foregroundStyle(.secondary)
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
                    Toggle("Read replies aloud", isOn: $model.preferences.speakReplies)
                }.padding(18).background(.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 12))
                Text("⌘ ⇧ Space opens Clicky. Hold ⌃ ⌥ Space to talk; release to send. The chat microphone records a draft. Screen capture is always your choice. BB retains messages and attachments; your configured voice service receives recorded audio.")
                    .font(.caption).foregroundStyle(.secondary).lineSpacing(4)
                Text("For a remote BB connection, enter its authenticated local proxy URL. If BB’s host daemon restarts, that URL may change; update it here and check the connection again.").font(.caption).foregroundStyle(.secondary)
                Text("Agents use BB’s approval flow. When a task needs permission, open its conversation in BB to continue.").font(.caption).foregroundStyle(.secondary)
                if let error = model.error { errorBanner(error) }
                HStack {
                    Button("Done") { model.save(); model.settingsVisible = false }.disabled(model.preferences.hostID.isEmpty || !model.connected)
                    Spacer()
                    Button("Quit Clicky") { NSApp.terminate(nil) }.buttonStyle(.plain).foregroundStyle(.secondary)
                }
            }.padding(30).frame(maxWidth: 650)
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    private func field(_ title: String, text: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 6) { Text(title).font(.caption).foregroundStyle(.secondary); TextField(title, text: text).textFieldStyle(.roundedBorder) }
    }
    private func errorBanner(_ text: String) -> some View {
        HStack(alignment: .top) {
            Image(systemName: "exclamationmark.circle").foregroundStyle(.orange)
            Text(text).font(.caption).textSelection(.enabled).lineLimit(5)
            Spacer(minLength: 0)
            Button("Retry connection") { Task { await model.connect() } }.font(.caption)
        }.padding(12).background(.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 8)).padding(.horizontal, 12)
    }
    private func iconButton(_ label: String, _ symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { Image(systemName: symbol).frame(width: 20, height: 22) }.buttonStyle(.plain).help(label).accessibilityLabel(label)
    }
}
