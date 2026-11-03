import AppKit
import ClickyCore
import Observation
import SwiftUI

/// Visuals are temporary output over the user's current app, not another workspace.
final class VisualWindowController: NSObject {
    private let model: CompanionModel
    private var contentPanel: VisualOutputPanel?
    private var kind: VisualKind?
    private var display: VisualDisplayContext?
    private let interaction = VisualInteractionState()
    private var playbackDeadline: Task<Void, Never>?
    private var playbackStarted = false
    private var playbackExpired = false
    var isPresented: Bool { contentPanel != nil }

    init(model: CompanionModel) {
        self.model = model
        super.init()
        NotificationCenter.default.addObserver(self, selector: #selector(displayContextChanged),
            name: NSApplication.didChangeScreenParametersNotification, object: nil)
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(displayContextChanged),
            name: NSWorkspace.activeSpaceDidChangeNotification, object: nil)
    }

    isolated deinit {
        NotificationCenter.default.removeObserver(self)
        NSWorkspace.shared.notificationCenter.removeObserver(self)
    }

    @objc private func displayContextChanged() { model.dismissVisuals() }

    func present() {
        guard let document = model.visualDocument, !document.nodes.isEmpty else { close(); return }
        guard let context = model.visualDisplay, let screen = context.matchingScreen else {
            close()
            model.visualWarning = "The display changed. Ask again on the screen you want to use."
            return
        }
        if kind != document.kind || display != context { close() }
        interaction.playing = !playbackExpired && document.nodes.contains { $0.animation != nil }
        if interaction.playing, !playbackStarted {
            playbackStarted = true
            playbackDeadline = Task { [weak self] in
                try? await Task.sleep(for: .seconds(30))
                guard !Task.isCancelled else { return }
                self?.playbackExpired = true; self?.interaction.playing = false
            }
        }
        guard contentPanel == nil else { return }
        kind = document.kind; display = context
        interaction.spread = 0; interaction.resetToken += 1
        let bounds = screen.visibleFrame
        let frame: CGRect
        if document.kind == .diagram {
            let width = min(620, max(320, bounds.width * 0.44))
            let height = min(470, max(280, bounds.height * 0.58))
            frame = CGRect(x: bounds.maxX - width - 22, y: bounds.midY - height / 2, width: width, height: height)
        } else if document.kind == .scene3d {
            let width = min(720, bounds.width - 44)
            let height = min(620, bounds.height - 90)
            frame = CGRect(x: bounds.maxX - width - 22, y: bounds.midY - height / 2, width: width, height: height)
        } else { frame = screen.frame }
        let panel = outputPanel(frame: frame)
        // Every 2D pixel passes through. For 3D, genuine alpha-zero window
        // regions use AppKit's native transparency hit testing; opaque objects
        // retain their normal orbit/selection gestures without mouse monitors.
        if document.kind != .scene3d { panel.ignoresMouseEvents = true }
        contentPanel = panel
        let hosting = VisualOutputHostingView(rootView: AnyView(VisualOutputView(model: model, interaction: interaction)))
        hosting.sizingOptions = []
        panel.contentView = hosting
        panel.orderFrontRegardless()
    }

    func close() {
        playbackDeadline?.cancel(); playbackDeadline = nil
        playbackStarted = false; playbackExpired = false
        interaction.playing = false
        contentPanel?.orderOut(nil); contentPanel?.contentView = nil
        contentPanel = nil
        kind = nil; display = nil
    }

    private func outputPanel(frame: CGRect) -> VisualOutputPanel {
        let panel = VisualOutputPanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.isMovableByWindowBackground = false
        panel.collectionBehavior = [.fullScreenAuxiliary, .ignoresCycle]
        return panel
    }

}

/// Neither arriving content nor clicks on its controls may take keyboard focus.
final class VisualOutputPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

private final class VisualOutputHostingView: NSHostingView<AnyView> {
    override var isOpaque: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

@Observable private final class VisualInteractionState {
    var spread = 0.0
    var playing = false
    var resetToken = 0
}

private struct VisualOutputView: View {
    @Bindable var model: CompanionModel
    @Bindable var interaction: VisualInteractionState

    var body: some View {
        if let document = model.visualDocument, !document.nodes.isEmpty {
            let revision = model.visualRevision
            VisualCanvas(document: document, selectedID: Binding(get: { model.selectedVisualNodeID }, set: { id in
                guard model.visualRevision == revision, model.visualDocument == document else { return }
                model.selectedVisualNodeID = id
            }), spread: interaction.spread, playing: interaction.playing, resetToken: interaction.resetToken)
                .clipShape(RoundedRectangle(cornerRadius: document.kind == .diagram ? 14 : 0))
        }
    }
}

