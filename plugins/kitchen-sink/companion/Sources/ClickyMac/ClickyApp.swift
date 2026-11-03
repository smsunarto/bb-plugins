import AppKit
import SwiftUI
import Observation

/// A background companion, with no app windows, menus, or Settings scene.
@main @MainActor enum ClickyApp {
    private static let delegate = CompanionDelegate()
    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        app.delegate = delegate
        app.mainMenu = nil
        app.run()
    }
}

final class CompanionDelegate: NSObject, NSApplicationDelegate {
    let model = CompanionModel()
    private var notch: NotchPanel?
    private var visualWindow: VisualWindowController?
    private var terminationHandler: DispatchSourceSignal?

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
