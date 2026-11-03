import AppKit
import ClickyCore
import Observation
import SwiftUI

/// Visuals are temporary output over the user's current app, not another workspace.
final class VisualWindowController: NSObject {
    private let model: CompanionModel
    private var contentPanel: VisualOutputPanel?
    private var clearPanel: VisualOutputPanel?
    private var controlsPanel: VisualOutputPanel?
    private var kind: VisualKind?
    private var display: VisualDisplayContext?
    private let interaction = VisualInteractionState()
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
        guard contentPanel == nil else { return }
        kind = document.kind; display = context
        interaction.spread = 0; interaction.playing = false; interaction.resetToken += 1
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
        let hosting = VisualOutputHostingView(rootView: AnyView(VisualOutputView(model: model, interaction: interaction,
            sceneReady: { [weak self] scene in
                scene.onGestureBegan = { [weak self] in self?.showControls() }
            })))
        hosting.sizingOptions = []
        panel.contentView = hosting
        panel.orderFrontRegardless()
        showClear(on: screen)
    }

    func close() {
        interaction.playing = false
        for panel in [contentPanel, clearPanel, controlsPanel] { panel?.orderOut(nil); panel?.contentView = nil }
        contentPanel = nil; clearPanel = nil; controlsPanel = nil
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

    private func showClear(on screen: NSScreen) {
        let bounds = screen.visibleFrame
        let panel = outputPanel(frame: CGRect(x: min(bounds.maxX - 96, bounds.midX + 157), y: bounds.maxY - 36, width: 86, height: 30))
        panel.level = .popUpMenu
        panel.contentView = VisualOutputHostingView(rootView: AnyView(
            Button { [weak self] in self?.model.dismissVisuals() } label: {
                Label("Clear", systemImage: "xmark").font(.system(size: 12, weight: .medium))
                    .frame(width: 86, height: 30)
                    .foregroundStyle(VisualPalette.ink)
                    .background(VisualPalette.paper, in: Capsule())
            }.buttonStyle(.plain).accessibilityLabel("Clear visual overlay")))
        clearPanel = panel
        panel.orderFrontRegardless()
    }

    private func showControls() {
        guard controlsPanel == nil, kind == .scene3d, let screen = display?.matchingScreen else { return }
        let bounds = screen.visibleFrame
        let panel = outputPanel(frame: CGRect(x: bounds.maxX - 354, y: bounds.minY + 22, width: 332, height: 150))
        panel.level = .popUpMenu
        panel.contentView = VisualOutputHostingView(rootView: AnyView(VisualObjectControls(model: model, interaction: interaction,
            close: { [weak self] in self?.controlsPanel?.orderOut(nil); self?.controlsPanel = nil })))
        controlsPanel = panel
        panel.orderFrontRegardless()
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
    let sceneReady: (ClickySceneView) -> Void

    var body: some View {
        if let document = model.visualDocument, !document.nodes.isEmpty {
            let revision = model.visualRevision
            VisualCanvas(document: document, selectedID: Binding(get: { model.selectedVisualNodeID }, set: { id in
                guard model.visualRevision == revision, model.visualDocument == document else { return }
                model.selectedVisualNodeID = id
            }), spread: interaction.spread, playing: interaction.playing, resetToken: interaction.resetToken,
                sceneReady: sceneReady)
                .clipShape(RoundedRectangle(cornerRadius: document.kind == .diagram ? 14 : 0))
        }
    }
}

/// Appears only after the user interacts with 3D geometry. It owns its small opaque footprint.
private struct VisualObjectControls: View {
    @Bindable var model: CompanionModel
    @Bindable var interaction: VisualInteractionState
    var close: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(verbatim: selected?.label ?? "Explore the model").font(.system(size: 12, weight: .semibold)).lineLimit(1)
                Spacer()
                Button(action: close) { Image(systemName: "xmark") }.accessibilityLabel("Hide model controls")
            }
            if let detail = selected?.detail, !detail.isEmpty {
                Text(verbatim: detail).font(.system(size: 11)).lineLimit(3).frame(maxWidth: .infinity, alignment: .leading)
            } else { Text("Drag a solid part to rotate. Scroll over it to zoom.").font(.system(size: 11)).foregroundStyle(.secondary) }
            Spacer(minLength: 0)
            HStack(spacing: 10) {
                Button(interaction.playing ? "Pause" : "Play") { interaction.playing.toggle() }
                Text("Spread").font(.caption)
                Slider(value: $interaction.spread, in: 0...1).accessibilityLabel("Spread model parts")
                Button("Reset") { interaction.spread = 0; interaction.playing = false; interaction.resetToken += 1 }
            }.font(.system(size: 11))
        }.padding(13).foregroundStyle(VisualPalette.ink)
            .buttonStyle(.plain)
            .background(VisualPalette.paper, in: RoundedRectangle(cornerRadius: 13))
    }
    private var selected: VisualNode? { model.visualDocument?.nodes.first { $0.id == model.selectedVisualNodeID } }
}
