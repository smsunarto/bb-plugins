import Foundation

/// One instance belongs to one requested root turn. Completed messages replace their deltas.
public struct VisualStream: Sendable {
    public private(set) var preview: VisualDocument?
    public private(set) var completedDocument: VisualDocument?
    public private(set) var warning: String?
    public private(set) var revision = 0
    public private(set) var hasVisualContent = false
    public static let maximumBytes = 256 * 1_024

    private struct Item: Sendable { var text: String; var complete: Bool }
    private var items: [String: Item] = [:]
    private var order: [String] = []
    public init() {}

    public mutating func append(delta: String, itemID: String) {
        update(text: (items[itemID]?.text ?? "") + delta, itemID: itemID, complete: false)
    }

    public mutating func replace(text: String, itemID: String) {
        update(text: text, itemID: itemID, complete: true)
    }

    public func displayText(for itemID: String) -> String {
        Self.visibleText(items[itemID]?.text ?? "")
    }

    /// Hides protocol source during partial streaming as well as after completion.
    public static func visibleText(_ raw: String) -> String {
        var inside = false
        var visible: [String] = []
        for line in raw.components(separatedBy: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed == "```clicky-visual" { inside = true; continue }
            if inside {
                if trimmed == "```" { inside = false }
                continue
            }
            // A token stream may stop halfway through the opening fence.
            if !trimmed.isEmpty, "```clicky-visual".hasPrefix(trimmed), trimmed.hasPrefix("``") { continue }
            visible.append(line)
        }
        return visible.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private mutating func update(text: String, itemID: String, complete: Bool) {
        let others = items.reduce(0) { $0 + ($1.key == itemID ? 0 : $1.value.text.utf8.count) }
        guard text.utf8.count <= Self.maximumBytes - others, itemID.utf8.count <= 256,
              items[itemID] != nil || items.count < 64 else {
            warning = "The visual exceeded its size limit. Ask for a smaller scene."
            completedDocument = nil
            return
        }
        if items[itemID] == nil { order.append(itemID) }
        items[itemID] = Item(text: text, complete: complete)
        let oldPreview = preview
        var result = Parsed()
        var fallback: VisualDocument?
        for key in order {
            guard let item = items[key] else { continue }
            let parsed = Self.parse(item.text, flushLastLine: item.complete)
            if parsed.sawProtocol {
                result = parsed
                if let document = parsed.preview { fallback = document }
            }
        }
        hasVisualContent = result.sawProtocol
        preview = result.preview ?? fallback
        completedDocument = result.done && result.warning == nil ? result.preview : nil
        warning = result.warning
        if preview != oldPreview { revision += 1 }
    }

    private struct Parsed {
        var preview: VisualDocument?
        var done = false
        var warning: String?
        var sawProtocol = false
    }

    private static func parse(_ text: String, flushLastLine: Bool) -> Parsed {
        var result = Parsed()
        var inside = false
        let lines = text.components(separatedBy: "\n")
        let count = flushLastLine || text.hasSuffix("\n") ? lines.count : max(0, lines.count - 1)
        for line in lines.prefix(count) {
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed == "```clicky-visual" { inside = true; result.sawProtocol = true; continue }
            if inside, trimmed == "```" { inside = false; continue }
            guard inside, !trimmed.isEmpty else { continue }
            do {
                let operation = try JSONDecoder().decode(Operation.self, from: Data(trimmed.utf8))
                if operation.op == "scene" {
                    guard let kind = operation.kind, let title = operation.title else { throw missingFields }
                    let document = VisualDocument(kind: kind, title: title, summary: operation.summary ?? "")
                    try document.validate(requireResolvedEdges: false)
                    result.preview = document
                    result.done = false
                    result.warning = nil
                    continue
                }
                guard let current = result.preview else { throw VisualValidationError.invalid("Start a visual with a scene operation.") }
                guard !result.done else { throw VisualValidationError.invalid("Start a new scene before changing a completed visual.") }
                switch operation.op {
                case "node":
                    let node = try operation.node(kind: current.kind)
                    var nodes = current.nodes
                    if let index = nodes.firstIndex(where: { $0.id == node.id }) { nodes[index] = node }
                    else { nodes.append(node) }
                    let next = VisualDocument(kind: current.kind, title: current.title, summary: current.summary, nodes: nodes, edges: current.edges)
                    try next.validate(requireResolvedEdges: false)
                    result.preview = next
                case "edge":
                    guard let id = operation.id, let from = operation.from, let to = operation.to else { throw missingFields }
                    let edge = VisualEdge(id: id, from: from, to: to, label: operation.label ?? "")
                    var edges = current.edges
                    if let index = edges.firstIndex(where: { $0.id == id }) { edges[index] = edge }
                    else { edges.append(edge) }
                    let next = VisualDocument(kind: current.kind, title: current.title, summary: current.summary, nodes: current.nodes, edges: edges)
                    try next.validate(requireResolvedEdges: false)
                    result.preview = next
                case "done":
                    _ = try current.validated()
                    result.done = true
                default:
                    throw VisualValidationError.invalid("Unsupported visual operation.")
                }
            } catch let error as VisualValidationError {
                result.warning = error.localizedDescription
                result.done = false
            } catch {
                result.warning = "A visual operation could not be read. The last valid preview is still shown."
                result.done = false
            }
        }
        return result
    }

    private static var missingFields: VisualValidationError { .invalid("A visual operation is missing required fields.") }

    private struct Operation: Decodable {
        let op: String
        let kind: VisualKind?
        let title: String?
        let summary: String?
        let id: String?
        let shape: VisualShape?
        let position: [Double]?
        let size: [Double]?
        let rotation: [Double]?
        let color: VisualColor?
        let label: String?
        let detail: String?
        let animation: Animation?
        let vertices: [[Double]]?
        let triangles: [Int]?
        let from: String?
        let to: String?

        struct Animation: Decodable {
            let translation: [Double]?
            let rotation: [Double]?
            let duration: Double
        }

        func node(kind: VisualKind) throws -> VisualNode {
            guard let id, let shape, let position, let size else { throw VisualStream.missingFields }
            let is3D = kind == .scene3d
            let positionVector = try Self.vector(position, allow2D: !is3D, defaultZ: 0)
            let sizeVector = try Self.vector(size, allow2D: !is3D, defaultZ: 1)
            let rotationVector = try Self.vector(rotation ?? [0, 0, 0])
            let animationValue: VisualAnimation?
            if let animation {
                animationValue = VisualAnimation(translation: try Self.vector(animation.translation ?? [0, 0, 0]),
                    rotation: try Self.vector(animation.rotation ?? [0, 0, 0]), duration: animation.duration)
            } else { animationValue = nil }
            return VisualNode(id: id, shape: shape, position: positionVector, size: sizeVector,
                color: color ?? .cyan, label: label ?? "", detail: detail ?? "", rotation: rotationVector,
                animation: animationValue, vertices: try (vertices ?? []).map { try Self.vector($0) }, triangles: triangles ?? [])
        }

        private static func vector(_ values: [Double], allow2D: Bool = false, defaultZ: Double = 0) throws -> VisualVector {
            guard values.count == 3 || (allow2D && values.count == 2), values.allSatisfy(\.isFinite) else {
                throw VisualValidationError.invalid("Coordinates need finite numbers with the correct dimensions.")
            }
            return VisualVector(x: values[0], y: values[1], z: values.count == 3 ? values[2] : defaultZ)
        }
    }
}
