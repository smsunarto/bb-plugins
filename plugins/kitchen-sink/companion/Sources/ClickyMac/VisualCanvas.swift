import AppKit
import ClickyCore
import SwiftUI

/// Rendering consumes validated values only; the parent owns requests and presentation.
struct VisualCanvas: View {
    let document: VisualDocument
    @Binding var selectedID: String?
    var spread: Double = 0
    var playing = false
    var resetToken = 0
    var sceneReady: ((ClickySceneView) -> Void)? = nil
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            if document.kind == .scene3d {
                VisualSceneView(document: document, selectedID: $selectedID,
                    spread: spread, playing: playing && !reduceMotion, resetToken: resetToken, sceneReady: sceneReady)
            } else {
                VisualDiagram(document: document, selectedID: $selectedID)
            }
        }
        .accessibilityLabel(document.title)
    }
}

/// Monokai palette shared with the companion. Text is drawn verbatim, never as links or code.
enum VisualPalette {
    static let paper = Color(red: 227 / 255, green: 227 / 255, blue: 221 / 255)
    static let ink = Color(red: 24 / 255, green: 24 / 255, blue: 24 / 255)

    static func color(_ value: VisualColor) -> Color { Color(nsColor: native(value)) }
    static func native(_ value: VisualColor) -> NSColor {
        let rgb: (Double, Double, Double) = switch value {
        case .cyan: (81, 218, 233)
        case .purple: (168, 149, 254)
        case .green: (157, 221, 84)
        case .yellow: (247, 208, 92)
        case .pink: (254, 93, 134)
        case .orange: (255, 131, 66)
        case .white: (227, 227, 221)
        case .gray: (133, 133, 133)
        }
        return NSColor(srgbRed: rgb.0 / 255, green: rgb.1 / 255, blue: rgb.2 / 255, alpha: 1)
    }
}

private struct VisualDiagram: View {
    let document: VisualDocument
    @Binding var selectedID: String?

    var body: some View {
        GeometryReader { proxy in
            let size = proxy.size
            ZStack(alignment: .topLeading) {
                if document.kind == .diagram {
                    VisualPalette.paper
                    Canvas { context, canvasSize in
                        var grid = Path()
                        for x in stride(from: 0.0, through: canvasSize.width, by: 24) {
                            grid.move(to: CGPoint(x: x, y: 0)); grid.addLine(to: CGPoint(x: x, y: canvasSize.height))
                        }
                        for y in stride(from: 0.0, through: canvasSize.height, by: 24) {
                            grid.move(to: CGPoint(x: 0, y: y)); grid.addLine(to: CGPoint(x: canvasSize.width, y: y))
                        }
                        context.stroke(grid, with: .color(VisualPalette.ink.opacity(0.045)), lineWidth: 0.5)
                    }.allowsHitTesting(false)
                }
                ForEach(document.edges, id: \.id) { edge in
                    if let from = document.nodes.first(where: { $0.id == edge.from }),
                       let to = document.nodes.first(where: { $0.id == edge.to }) {
                        DiagramConnector(from: from, to: to, label: edge.label, canvasSize: size,
                            onDesktop: document.kind == .overlay)
                            .allowsHitTesting(false)
                    }
                }
                ForEach(document.nodes, id: \.id) { node in
                    DiagramNode(node: node, selected: selectedID == node.id,
                        onDesktop: document.kind == .overlay, canvasSize: size)
                        .onTapGesture { selectedID = node.id }
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(node.label.isEmpty ? node.id : node.label)
                        .accessibilityHint("Select for an explanation")
                        .accessibilityAddTraits(.isButton)
                        .accessibilityAction { selectedID = node.id }
                }
            }
            .clipped()
        }
    }
}

private struct DiagramNode: View {
    let node: VisualNode
    let selected: Bool
    let onDesktop: Bool
    let canvasSize: CGSize

    var body: some View {
        let width = max(1, node.size.x * canvasSize.width / 1000)
        let height = max(1, node.size.y * canvasSize.height / 1000)
        let x = node.position.x * canvasSize.width / 1000
        let y = node.position.y * canvasSize.height / 1000
        let tint = VisualPalette.color(node.color)
        let foreground = onDesktop ? Color.white : VisualPalette.ink
        Group {
            if node.shape == .line {
                Path { path in
                    path.move(to: CGPoint(x: x, y: y))
                    let angle = node.rotation.z * .pi / 180
                    path.addLine(to: CGPoint(x: x + width * cos(angle) - height * sin(angle),
                                            y: y + width * sin(angle) + height * cos(angle)))
                }
                .stroke(tint, style: StrokeStyle(lineWidth: selected ? 5 : 3, lineCap: .round))
            } else {
                ZStack {
                    if node.shape == .ellipse {
                        Ellipse().fill(tint.opacity(onDesktop ? 0.12 : 0.25))
                        Ellipse().strokeBorder(tint, lineWidth: selected ? 4 : 2)
                    } else if node.shape != .text {
                        RoundedRectangle(cornerRadius: 8).fill(tint.opacity(onDesktop ? 0.15 : 0.27))
                        RoundedRectangle(cornerRadius: 8).strokeBorder(tint, lineWidth: selected ? 4 : 2)
                    }
                    Text(node.label)
                        .font(.system(size: min(20, max(11, height * 0.24)), weight: .medium, design: .rounded))
                        .multilineTextAlignment(.center)
                        .foregroundStyle(foreground)
                        .lineLimit(5)
                        .minimumScaleFactor(0.65)
                        .padding(node.shape == .text ? 2 : 8)
                        .shadow(color: onDesktop ? .black : .clear, radius: 3)
                }
                .frame(width: width, height: height)
                .contentShape(node.shape == .ellipse ? AnyShape(Ellipse()) : AnyShape(Rectangle()))
                .rotationEffect(.degrees(node.rotation.z))
                .position(x: x, y: y)
            }
        }
    }
}

private struct DiagramConnector: View {
    let from: VisualNode
    let to: VisualNode
    let label: String
    let canvasSize: CGSize
    let onDesktop: Bool

    var body: some View {
        let start = boundary(of: from, toward: to)
        let end = boundary(of: to, toward: from)
        let angle = atan2(end.y - start.y, end.x - start.x)
        let color = onDesktop ? Color.white : VisualPalette.ink.opacity(0.7)
        ZStack(alignment: .topLeading) {
            Path { path in
                path.move(to: start); path.addLine(to: end)
                path.move(to: CGPoint(x: end.x - 9 * cos(angle - .pi / 6), y: end.y - 9 * sin(angle - .pi / 6)))
                path.addLine(to: end)
                path.addLine(to: CGPoint(x: end.x - 9 * cos(angle + .pi / 6), y: end.y - 9 * sin(angle + .pi / 6)))
            }.stroke(color, style: StrokeStyle(lineWidth: 1.6, lineCap: .round, lineJoin: .round))
            if !label.isEmpty {
                Text(label).font(.system(size: 11, weight: .medium, design: .rounded))
                    .lineLimit(2).multilineTextAlignment(.center)
                    .foregroundStyle(color)
                    .padding(.horizontal, 6).padding(.vertical, 3)
                    .background(onDesktop ? Color.black.opacity(0.65) : VisualPalette.paper.opacity(0.95), in: RoundedRectangle(cornerRadius: 4))
                    .frame(maxWidth: min(150, canvasSize.width * 0.28))
                    .position(x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 - 12)
            }
        }
    }

    private func boundary(of node: VisualNode, toward other: VisualNode) -> CGPoint {
        let center = CGPoint(x: node.position.x * canvasSize.width / 1000, y: node.position.y * canvasSize.height / 1000)
        let dx = (other.position.x - node.position.x) * canvasSize.width / 1000
        let dy = (other.position.y - node.position.y) * canvasSize.height / 1000
        guard abs(dx) + abs(dy) > 0.001 else { return center }
        let halfWidth = node.size.x * canvasSize.width / 2000
        let halfHeight = node.size.y * canvasSize.height / 2000
        let scale: Double
        if node.shape == .ellipse {
            scale = 1 / sqrt(pow(dx / max(halfWidth, 0.01), 2) + pow(dy / max(halfHeight, 0.01), 2))
        } else {
            scale = min(halfWidth / max(abs(dx), 0.01), halfHeight / max(abs(dy), 0.01))
        }
        return CGPoint(x: center.x + dx * min(scale, 0.48), y: center.y + dy * min(scale, 0.48))
    }
}
