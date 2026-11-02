import AppKit
import ClickyCore
import SceneKit
import SwiftUI
import simd

/// This representable is the only bridge into SceneKit. Its coordinator retains
/// the scene and camera while streamed documents update keyed geometry in place.
struct VisualSceneView: NSViewRepresentable {
    let document: VisualDocument
    @Binding var selectedID: String?
    let spread: Double
    let playing: Bool
    let resetToken: Int
    var sceneReady: ((ClickySceneView) -> Void)? = nil

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> ClickySceneSurface {
        let surface = ClickySceneSurface(frame: .zero)
        let view = surface.sceneView
        view.backgroundColor = .clear
        view.antialiasingMode = .multisampling4X
        view.autoenablesDefaultLighting = false
        view.rendersContinuously = false
        surface.setAccessibilityLabel("Interactive 3D scene. Drag a solid part to orbit and scroll to zoom.")
        context.coordinator.install(in: view)
        sceneReady?(view)
        return surface
    }

    func updateNSView(_ surface: ClickySceneSurface, context: Context) {
        let view = surface.sceneView
        view.onSelect = { selectedID = $0 }
        let changed = context.coordinator.update(document, in: view, selectedID: selectedID,
            spread: spread, playing: playing, resetToken: resetToken)
        surface.setPlaying(playing)
        if changed { surface.requestFrame() }
    }

    static func dismantleNSView(_ surface: ClickySceneSurface, coordinator: Coordinator) {
        surface.stop()
        surface.sceneView.onSelect = nil
        surface.sceneView.onGestureBegan = nil
        coordinator.stop()
        surface.sceneView.scene = nil
    }

    final class Coordinator {
        private struct Part {
            var value: VisualNode
            let root: SCNNode
            let motion: SCNNode
            let body: SCNNode
            let label: SCNNode
        }
        private let scene = SCNScene()
        private let content = SCNNode()
        private let connections = SCNNode()
        private let camera = SCNNode()
        private var parts: [String: Part] = [:]
        private var previous: VisualDocument?
        private var previousSelection: String?
        private var previousSpread: Double = 0
        private var previousPlaying = false
        private var previousReset = 0
        private var framed = false
        private var labelScale: CGFloat = 1

        func install(in view: ClickySceneView) {
            scene.background.contents = NSColor.clear
            scene.rootNode.addChildNode(content)
            content.addChildNode(connections)
            camera.camera = SCNCamera()
            camera.camera?.fieldOfView = 42
            camera.camera?.zNear = 0.01
            camera.camera?.zFar = 1000
            camera.camera?.wantsHDR = false
            scene.rootNode.addChildNode(camera)
            let ambient = SCNNode()
            ambient.light = SCNLight()
            ambient.light?.type = .ambient
            ambient.light?.intensity = 550
            ambient.light?.color = NSColor(white: 0.93, alpha: 1)
            scene.rootNode.addChildNode(ambient)
            let key = SCNNode()
            key.light = SCNLight()
            key.light?.type = .directional
            key.light?.intensity = 1400
            key.position = SCNVector3(8, 12, 10)
            key.look(at: SCNVector3Zero)
            scene.rootNode.addChildNode(key)
            let fill = SCNNode()
            fill.light = SCNLight()
            fill.light?.type = .directional
            fill.light?.intensity = 650
            fill.light?.color = VisualPalette.native(.cyan).blended(withFraction: 0.8, of: .white) ?? .white
            fill.position = SCNVector3(-8, 3, -5)
            fill.look(at: SCNVector3Zero)
            scene.rootNode.addChildNode(fill)
            view.scene = scene
            view.pointOfView = camera
            view.defaultCameraController.inertiaEnabled = false
            view.defaultCameraController.interactionMode = .orbitTurntable
            view.defaultCameraController.minimumVerticalAngle = -85
            view.defaultCameraController.maximumVerticalAngle = 85
        }

        @discardableResult
        func update(_ document: VisualDocument, in view: ClickySceneView,
                    selectedID: String?, spread: Double, playing: Bool, resetToken: Int) -> Bool {
            guard previous != document || previousSelection != selectedID || previousSpread != spread ||
                    previousPlaying != playing || previousReset != resetToken else { return false }
            let newIDs = Set(document.nodes.map(\.id))
            for id in Array(parts.keys) where !newIDs.contains(id) {
                parts.removeValue(forKey: id)?.root.removeFromParentNode()
            }
            let changed = previous != document
            let spreadChanged = spread != previousSpread
            let playbackChanged = playing != previousPlaying
            SCNTransaction.begin()
            SCNTransaction.animationDuration = 0
            for value in document.nodes {
                let part: Part
                let valueChanged: Bool
                if let current = parts[value.id] {
                    part = current
                    valueChanged = current.value != value
                } else {
                    let root = SCNNode()
                    root.name = value.id
                    let motion = SCNNode()
                    let body = SCNNode()
                    let label = SCNNode()
                    root.addChildNode(motion)
                    motion.addChildNode(body)
                    motion.addChildNode(label)
                    content.addChildNode(root)
                    part = Part(value: value, root: root, motion: motion, body: body, label: label)
                    valueChanged = true
                }
                if valueChanged {
                    part.body.geometry = geometry(for: value)
                    part.body.scale = vector(value.size)
                    part.root.eulerAngles = radians(value.rotation)
                    replaceLabel(part.label, text: value.label, color: value.color)
                    part.label.position = labelPosition(for: value)
                    parts[value.id] = Part(value: value, root: part.root, motion: part.motion, body: part.body, label: part.label)
                }
                if valueChanged || spreadChanged {
                    part.root.position = vector(value.position, multiplier: 1 + spread * 0.65)
                }
                let selected = value.id == selectedID
                part.body.geometry?.firstMaterial?.emission.contents = selected ? VisualPalette.native(value.color).withAlphaComponent(0.3) : NSColor.black
                part.body.geometry?.firstMaterial?.emission.intensity = selected ? 0.45 : 0
                part.label.opacity = 1
                if valueChanged || playbackChanged { configureAnimation(part, value: value, playing: playing) }
            }
            SCNTransaction.commit()
            if changed || spreadChanged { rebuildConnections(document, spread: spread) }
            let resetRequested = resetToken != previousReset
            if resetRequested { view.userCameraInteraction = false }
            if !view.userCameraInteraction && (changed || spreadChanged || resetRequested || !framed) {
                frame(document, in: view)
                framed = !document.nodes.isEmpty
            }
            if playbackChanged || changed {
                if playing && !document.nodes.contains(where: { $0.animation != nil }) {
                    if content.action(forKey: "orbit") == nil {
                        content.runAction(.repeatForever(.rotateBy(x: 0, y: .pi * 2, z: 0, duration: 24)), forKey: "orbit")
                    }
                } else {
                    content.removeAction(forKey: "orbit")
                    content.eulerAngles = SCNVector3Zero
                }
            }
            view.validIDs = newIDs
            view.isPlaying = playing
            view.needsDisplay = true
            previous = document
            previousSelection = selectedID
            previousSpread = spread
            previousPlaying = playing
            previousReset = resetToken
            return true
        }

        private func geometry(for node: VisualNode) -> SCNGeometry {
            let geometry: SCNGeometry
            switch node.shape {
            case .sphere:
                let sphere = SCNSphere(radius: 0.5); sphere.segmentCount = 32; geometry = sphere
            case .cylinder:
                let cylinder = SCNCylinder(radius: 0.5, height: 1); cylinder.radialSegmentCount = 32; geometry = cylinder
            case .cone:
                let cone = SCNCone(topRadius: 0, bottomRadius: 0.5, height: 1); cone.radialSegmentCount = 32; geometry = cone
            case .torus:
                let torus = SCNTorus(ringRadius: 0.35, pipeRadius: 0.15); torus.ringSegmentCount = 40; torus.pipeSegmentCount = 16; geometry = torus
            case .plane:
                geometry = SCNPlane(width: 1, height: 1)
            case .capsule:
                let capsule = SCNCapsule(capRadius: 0.25, height: 1); capsule.radialSegmentCount = 24; geometry = capsule
            case .mesh:
                geometry = mesh(node)
            default:
                geometry = SCNBox(width: 1, height: 1, length: 1, chamferRadius: 0.045)
            }
            let material = SCNMaterial()
            material.diffuse.contents = VisualPalette.native(node.color)
            material.lightingModel = .physicallyBased
            material.metalness.contents = 0.15
            material.roughness.contents = 0.42
            material.isDoubleSided = node.shape == .plane || node.shape == .mesh
            geometry.materials = [material]
            return geometry
        }

        private func mesh(_ node: VisualNode) -> SCNGeometry {
            var vertices: [SCNVector3] = []
            var normals: [SCNVector3] = []
            for offset in stride(from: 0, to: node.triangles.count, by: 3) {
                let a = vector(node.vertices[node.triangles[offset]])
                let b = vector(node.vertices[node.triangles[offset + 1]])
                let c = vector(node.vertices[node.triangles[offset + 2]])
                let av = SIMD3<Float>(Float(a.x), Float(a.y), Float(a.z)), bv = SIMD3<Float>(Float(b.x), Float(b.y), Float(b.z)), cv = SIMD3<Float>(Float(c.x), Float(c.y), Float(c.z))
                let cross = simd_cross(bv - av, cv - av)
                let normal = simd_length_squared(cross) > 0.000001 ? simd_normalize(cross) : SIMD3<Float>(0, 1, 0)
                vertices += [a, b, c]
                normals += Array(repeating: SCNVector3(normal.x, normal.y, normal.z), count: 3)
            }
            let indices = (0..<vertices.count).map(Int32.init)
            return SCNGeometry(sources: [.init(vertices: vertices), .init(normals: normals)],
                elements: [SCNGeometryElement(indices: indices, primitiveType: .triangles)])
        }

        private func replaceLabel(_ holder: SCNNode, text: String, color: VisualColor) {
            holder.childNodes.forEach { $0.removeFromParentNode() }
            guard !text.isEmpty else { return }
            let label = SCNText(string: String(text.prefix(48)), extrusionDepth: 0)
            label.font = NSFont.systemFont(ofSize: 12, weight: .semibold)
            label.flatness = 0.35
            let textMaterial = SCNMaterial()
            textMaterial.lightingModel = .constant
            textMaterial.readsFromDepthBuffer = false
            textMaterial.writesToDepthBuffer = false
            textMaterial.diffuse.contents = NSColor(srgbRed: 0.07, green: 0.07, blue: 0.07, alpha: 1)
            label.materials = [textMaterial]
            let (low, high) = label.boundingBox
            let textScale: CGFloat = 0.021
            let width = max(0.25, (high.x - low.x) * textScale)
            let height = max(0.2, (high.y - low.y) * textScale)
            let background = SCNPlane(width: CGFloat(width + 0.18), height: CGFloat(height + 0.14))
            background.cornerRadius = 0.055
            let paper = SCNMaterial()
            paper.lightingModel = .constant
            paper.readsFromDepthBuffer = false
            paper.writesToDepthBuffer = false
            paper.diffuse.contents = VisualPalette.native(color).blended(withFraction: 0.7, of: VisualPalette.native(.white)) ?? .white
            paper.isDoubleSided = true
            background.materials = [paper]
            let plate = SCNNode(geometry: background)
            plate.renderingOrder = 1000
            holder.addChildNode(plate)
            let textNode = SCNNode(geometry: label)
            textNode.renderingOrder = 1001
            textNode.scale = SCNVector3(textScale, textScale, textScale)
            textNode.position = SCNVector3(-(high.x + low.x) * textScale / 2, -(high.y + low.y) * textScale / 2, 0.005)
            holder.addChildNode(textNode)
            holder.constraints = [SCNBillboardConstraint()]
            holder.scale = SCNVector3(labelScale, labelScale, labelScale)
        }

        private func labelPosition(for value: VisualNode) -> SCNVector3 {
            SCNVector3(value.size.x > 2 ? CGFloat(-value.size.x * 0.45) : 0,
                CGFloat(value.size.y / 2) + 0.45 * labelScale, 0)
        }

        private func configureAnimation(_ part: Part, value: VisualNode, playing: Bool) {
            part.motion.removeAllActions()
            part.motion.position = SCNVector3Zero
            part.motion.eulerAngles = SCNVector3Zero
            guard playing, let animation = value.animation else { return }
            let movement = SCNAction.moveBy(x: CGFloat(animation.translation.x), y: CGFloat(animation.translation.y), z: CGFloat(animation.translation.z), duration: animation.duration)
            let rotation = SCNAction.rotateBy(x: CGFloat(animation.rotation.x * .pi / 180), y: CGFloat(animation.rotation.y * .pi / 180), z: CGFloat(animation.rotation.z * .pi / 180), duration: animation.duration)
            let action = SCNAction.group([movement, rotation])
            action.timingMode = .easeInEaseOut
            part.motion.runAction(.repeatForever(.sequence([action, .wait(duration: 0.4), action.reversed(), .wait(duration: 0.4)])), forKey: "explain")
        }

        private func rebuildConnections(_ document: VisualDocument, spread: Double) {
            connections.childNodes.forEach { $0.removeFromParentNode() }
            for edge in document.edges {
                guard let from = document.nodes.first(where: { $0.id == edge.from }),
                      let to = document.nodes.first(where: { $0.id == edge.to }) else { continue }
                let start = vector(from.position, multiplier: 1 + spread * 0.65)
                let end = vector(to.position, multiplier: 1 + spread * 0.65)
                let delta = SIMD3<Float>(Float(end.x - start.x), Float(end.y - start.y), Float(end.z - start.z))
                let length = simd_length(delta)
                guard length > 0.001 else { continue }
                let rod = SCNNode(geometry: SCNCylinder(radius: 0.018, height: CGFloat(length)))
                rod.geometry?.firstMaterial?.diffuse.contents = VisualPalette.native(.white)
                rod.position = SCNVector3((start.x + end.x) / 2, (start.y + end.y) / 2, (start.z + end.z) / 2)
                rod.simdOrientation = simd_quatf(from: SIMD3<Float>(0, 1, 0), to: simd_normalize(delta))
                connections.addChildNode(rod)
                if !edge.label.isEmpty {
                    let label = SCNNode()
                    replaceLabel(label, text: edge.label, color: .white)
                    label.position = rod.position
                    label.position.y += 0.18
                    connections.addChildNode(label)
                }
            }
        }

        private func frame(_ document: VisualDocument, in view: ClickySceneView) {
            guard !document.nodes.isEmpty else { return }
            // Fit only base geometry. Billboard labels and current animation time
            // must not make the result depend on streaming chunk boundaries.
            var lower = SIMD3<Double>(repeating: .greatestFiniteMagnitude)
            var upper = SIMD3<Double>(repeating: -.greatestFiniteMagnitude)
            for part in parts.values {
                let (low, high) = part.body.boundingBox
                for x in [low.x, high.x] {
                    for y in [low.y, high.y] {
                        for z in [low.z, high.z] {
                            let scaled = part.body.convertPosition(SCNVector3(x, y, z), to: part.motion)
                            let world = part.root.convertPosition(scaled, to: content)
                            let corner = SIMD3<Double>(Double(world.x), Double(world.y), Double(world.z))
                            lower = simd_min(lower, corner)
                            upper = simd_max(upper, corner)
                        }
                    }
                }
            }
            let midpoint = (lower + upper) / 2
            let radius = max(1.2, simd_length(upper - lower) / 2)
            let center = SCNVector3(CGFloat(midpoint.x), CGFloat(midpoint.y), CGFloat(midpoint.z))
            labelScale = CGFloat(max(0.6, radius / 4))
            for part in parts.values {
                part.label.scale = SCNVector3(labelScale, labelScale, labelScale)
                part.label.position = labelPosition(for: part.value)
            }
            view.defaultCameraController.stopInertia()
            view.pointOfView = camera
            camera.position = SCNVector3(center.x + CGFloat(radius * 1.45), center.y + CGFloat(radius * 1.05), center.z + CGFloat(radius * 1.8))
            camera.look(at: center)
            view.defaultCameraController.target = center
        }

        func stop() {
            content.removeAllActions()
            for part in parts.values { part.motion.removeAllActions() }
            parts.removeAll()
        }

        private func vector(_ value: VisualVector, multiplier: Double = 1) -> SCNVector3 {
            SCNVector3(CGFloat(value.x * multiplier), CGFloat(value.y * multiplier), CGFloat(value.z * multiplier))
        }
        private func radians(_ value: VisualVector) -> SCNVector3 { vector(value, multiplier: .pi / 180) }
    }
}

/// SceneKit remains offscreen: its Metal layer consumes clicks over alpha-zero pixels.
/// Drawing its snapshot through AppKit gives WindowServer a real alpha hit mask,
/// including holes inside geometry. Only actual delivered gestures reach the camera.
final class ClickySceneSurface: NSView {
    let sceneView = ClickySceneView(frame: .zero)
    private let renderer = SCNRenderer(device: nil, options: nil)
    private(set) var renderedImage: NSImage?
    private var playbackTimer: Timer?
    private var playing = false
    private var downPoint: NSPoint?
    private var renderedSize = CGSize.zero
    private var renderedScale: CGFloat = 0
    private var frameRequested = false

    override var isOpaque: Bool { false }
    override var mouseDownCanMoveWindow: Bool { false }
    override var acceptsFirstResponder: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    isolated deinit { playbackTimer?.invalidate() }

    override func viewWillDraw() {
        if frameRequested { captureFrame() }
        super.viewWillDraw()
    }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.clear.setFill()
        dirtyRect.fill(using: .copy)
        renderedImage?.draw(in: bounds, from: .zero, operation: .copy, fraction: 1)
    }

    override func layout() {
        super.layout()
        if renderedSize != bounds.size { requestFrame() }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        updatePlaybackTimer()
        if window != nil { requestFrame() }
    }

    override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        if renderedScale != window?.backingScaleFactor { requestFrame() }
    }

    func setPlaying(_ value: Bool) {
        guard playing != value else { return }
        playing = value
        updatePlaybackTimer()
    }

    private func updatePlaybackTimer() {
        playbackTimer?.invalidate()
        playbackTimer = nil
        guard playing, window != nil else { return }
        let timer = Timer(timeInterval: 1 / 30, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.requestFrame() }
        }
        RunLoop.main.add(timer, forMode: .common)
        playbackTimer = timer
    }

    /// A static scene renders only after a content, camera, size or scale change.
    /// Playback is the only continuously sampled state; camera inertia is disabled.
    func requestFrame() {
        frameRequested = true
        needsDisplay = true
    }

    func renderFrame() {
        captureFrame()
        needsDisplay = true
    }

    private func captureFrame() {
        frameRequested = false
        guard bounds.width > 0, bounds.height > 0, let scene = sceneView.scene else { return }
        let scale = window?.backingScaleFactor ?? 1
        sceneView.frame = CGRect(origin: .zero, size: bounds.size)
        renderer.scene = scene
        renderer.pointOfView = sceneView.pointOfView
        renderer.isPlaying = playing
        renderedImage = renderer.snapshot(atTime: CACurrentMediaTime(),
            with: CGSize(width: bounds.width * scale, height: bounds.height * scale),
            antialiasingMode: .multisampling4X)
        renderedImage?.size = bounds.size
        renderedSize = bounds.size
        renderedScale = scale
    }

    func stop() {
        playbackTimer?.invalidate()
        playbackTimer = nil
        renderer.scene = nil
        renderedImage = nil
        frameRequested = false
    }

    private var cameraController: SCNCameraController {
        let controller = sceneView.defaultCameraController
        controller.pointOfView = sceneView.pointOfView
        return controller
    }

    private func beginGesture() {
        sceneView.noteUserCameraInteraction()
        sceneView.onGestureBegan?()
    }

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        downPoint = point
        beginGesture()
        cameraController.beginInteraction(point, withViewport: bounds.size)
    }

    override func mouseDragged(with event: NSEvent) {
        guard downPoint != nil else { return }
        cameraController.continueInteraction(convert(event.locationInWindow, from: nil),
            withViewport: bounds.size, sensitivity: 1)
        requestFrame()
    }

    override func mouseUp(with event: NSEvent) {
        guard let start = downPoint else { return }
        let point = convert(event.locationInWindow, from: nil)
        downPoint = nil
        cameraController.endInteraction(point, withViewport: bounds.size, velocity: .zero)
        if hypot(point.x - start.x, point.y - start.y) < 5 { sceneView.select(at: point) }
        requestFrame()
    }

    override func scrollWheel(with event: NSEvent) {
        beginGesture()
        let wheelScale: CGFloat = event.hasPreciseScrollingDeltas ? 1 : 10
        zoom(by: event.scrollingDeltaY * wheelScale * 0.008)
    }

    override func magnify(with event: NSEvent) {
        beginGesture()
        zoom(by: event.magnification)
    }

    private func zoom(by fraction: CGFloat) {
        guard let camera = sceneView.pointOfView else { return }
        let controller = cameraController
        let target = controller.target
        let offset = camera.position
        let distance = sqrt(pow(offset.x - target.x, 2) + pow(offset.y - target.y, 2) + pow(offset.z - target.z, 2))
        let nextDistance = min(500, max(0.2, distance * (1 - fraction)))
        // The distance clamp and movement share the same target axis, even
        // when the pointer is near the object's edge.
        controller.dolly(toTarget: Float(nextDistance - distance))
        requestFrame()
    }
}

/// Offscreen geometry, hit testing and camera state; never attached to a window.
final class ClickySceneView: SCNView {
    var onSelect: ((String?) -> Void)?
    var onGestureBegan: (() -> Void)?
    fileprivate(set) var userCameraInteraction = false
    var validIDs: Set<String> = []

    func noteUserCameraInteraction() { userCameraInteraction = true }

    func hitVisibleGeometry(at point: NSPoint) -> Bool {
        guard bounds.contains(point) else { return false }
        return hitTest(point, options: [.boundingBoxOnly: false, .ignoreHiddenNodes: true]).contains { $0.node.geometry != nil }
    }

    func select(at point: NSPoint) {
        for hit in hitTest(point, options: nil) {
            var node: SCNNode? = hit.node
            while let candidate = node {
                if let id = candidate.name, validIDs.contains(id) { onSelect?(id); return }
                node = candidate.parent
            }
        }
        onSelect?(nil)
    }
}
