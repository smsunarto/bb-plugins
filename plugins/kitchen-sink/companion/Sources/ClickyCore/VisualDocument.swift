import Foundation

public enum VisualKind: String, Codable, Sendable { case diagram, scene3d, overlay }
public enum VisualColor: String, Codable, Sendable, CaseIterable {
    case cyan, purple, green, yellow, pink, orange, white, gray
}
public enum VisualShape: String, Codable, Sendable {
    case rectangle, ellipse, text, line
    case box, sphere, cylinder, cone, torus, plane, capsule, mesh
    public var isThreeDimensional: Bool {
        switch self {
        case .rectangle, .ellipse, .text, .line: false
        default: true
        }
    }
}

/// Native graphics types stay in the renderer; the protocol contains only finite numbers.
public struct VisualVector: Codable, Equatable, Sendable {
    public let x: Double
    public let y: Double
    public let z: Double
    public init(x: Double, y: Double, z: Double = 0) { self.x = x; self.y = y; self.z = z }
    public static let zero = VisualVector(x: 0, y: 0)
    public static let one = VisualVector(x: 1, y: 1, z: 1)
    var values: [Double] { [x, y, z] }
}

public struct VisualAnimation: Codable, Equatable, Sendable {
    public let translation: VisualVector
    public let rotation: VisualVector
    public let duration: Double
    public init(translation: VisualVector = .zero, rotation: VisualVector = .zero, duration: Double = 2) {
        self.translation = translation; self.rotation = rotation; self.duration = duration
    }
}

public struct VisualNode: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let shape: VisualShape
    /// 2D positions are centers with a top-left origin. For line, position is the start.
    public let position: VisualVector
    /// Full extents. For line, size.x/size.y are nonnegative endpoint deltas.
    public let size: VisualVector
    public let color: VisualColor
    public let label: String
    public let detail: String
    public let rotation: VisualVector
    public let animation: VisualAnimation?
    public let vertices: [VisualVector]
    public let triangles: [Int]

    public init(id: String, shape: VisualShape, position: VisualVector, size: VisualVector,
                color: VisualColor = .cyan, label: String = "", detail: String = "",
                rotation: VisualVector = .zero, animation: VisualAnimation? = nil,
                vertices: [VisualVector] = [], triangles: [Int] = []) {
        self.id = id; self.shape = shape; self.position = position; self.size = size
        self.color = color; self.label = label; self.detail = detail; self.rotation = rotation
        self.animation = animation; self.vertices = vertices; self.triangles = triangles
    }
}

public struct VisualEdge: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let from: String
    public let to: String
    public let label: String
    public init(id: String, from: String, to: String, label: String = "") {
        self.id = id; self.from = from; self.to = to; self.label = label
    }
}

public enum VisualValidationError: Error, LocalizedError, Equatable, Sendable {
    case invalid(String)
    public var errorDescription: String? { if case let .invalid(message) = self { message } else { nil } }
}

public struct VisualDocument: Codable, Equatable, Sendable {
    public let version: Int
    public let kind: VisualKind
    public let title: String
    public let summary: String
    public let nodes: [VisualNode]
    public let edges: [VisualEdge]
    public init(version: Int = 1, kind: VisualKind, title: String, summary: String = "",
                nodes: [VisualNode] = [], edges: [VisualEdge] = []) {
        self.version = version; self.kind = kind; self.title = title; self.summary = summary
        self.nodes = nodes; self.edges = edges
    }

    /// Call after decoding a saved document, before giving it to a native renderer.
    public func validated() throws -> Self {
        try validate(requireResolvedEdges: true)
        return self
    }

    func validate(requireResolvedEdges: Bool) throws {
        guard version == 1 else { throw VisualValidationError.invalid("Unsupported visual version.") }
        guard !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, title.count <= 160, summary.count <= 2_000 else {
            throw VisualValidationError.invalid("Visual title or summary is too long or empty.")
        }
        guard nodes.count <= 96, edges.count <= 128 else { throw VisualValidationError.invalid("Visual has too many objects.") }
        if requireResolvedEdges, nodes.isEmpty { throw VisualValidationError.invalid("The visual has no objects yet.") }
        let ids = Set(nodes.map(\.id))
        guard ids.count == nodes.count, Set(edges.map(\.id)).count == edges.count else {
            throw VisualValidationError.invalid("Visual identifiers must be unique.")
        }
        var vertexCount = 0
        var indexCount = 0
        for node in nodes {
            try Self.validate(node, kind: kind)
            vertexCount += node.vertices.count
            indexCount += node.triangles.count
        }
        guard vertexCount <= 4_096, indexCount <= 12_288 else { throw VisualValidationError.invalid("Visual mesh budget exceeded.") }
        for edge in edges {
            guard Self.validID(edge.id), Self.validID(edge.from), Self.validID(edge.to), edge.label.count <= 160 else {
                throw VisualValidationError.invalid("Invalid visual connection.")
            }
            if requireResolvedEdges, !ids.contains(edge.from) || !ids.contains(edge.to) {
                throw VisualValidationError.invalid("A connection references an object that is missing.")
            }
        }
    }

    static func validID(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 80 && value.unicodeScalars.allSatisfy {
            CharacterSet.alphanumerics.contains($0) || "-_".unicodeScalars.contains($0)
        }
    }

    private static func validate(_ node: VisualNode, kind: VisualKind) throws {
        guard validID(node.id), node.label.count <= 160, node.detail.count <= 2_000 else {
            throw VisualValidationError.invalid("Invalid object identifier, label, or detail.")
        }
        let is3D = kind == .scene3d
        guard node.shape.isThreeDimensional == is3D else { throw VisualValidationError.invalid("Object shape does not match the visual kind.") }
        guard node.rotation.values.allSatisfy({ $0.isFinite && abs($0) <= 3_600 }) else {
            throw VisualValidationError.invalid("Invalid object rotation.")
        }
        if is3D {
            guard node.position.values.allSatisfy({ $0.isFinite && abs($0) <= 20 }),
                  node.size.values.allSatisfy({ $0.isFinite && (0.01...20).contains($0) }) else {
                throw VisualValidationError.invalid("3D position or size is outside the supported range.")
            }
        } else {
            guard node.position.values.allSatisfy(\.isFinite), (0...1_000).contains(node.position.x), (0...1_000).contains(node.position.y), node.position.z == 0,
                  node.size.values.allSatisfy(\.isFinite), node.size.z == 1, node.rotation.x == 0, node.rotation.y == 0 else {
                throw VisualValidationError.invalid("Invalid diagram coordinates.")
            }
            if node.shape == .line {
                guard (0...1_000).contains(node.size.x), (0...1_000).contains(node.size.y), node.size.x > 0 || node.size.y > 0 else {
                    throw VisualValidationError.invalid("Invalid line extent.")
                }
            } else {
                guard (1...1_000).contains(node.size.x), (1...1_000).contains(node.size.y) else {
                    throw VisualValidationError.invalid("Diagram size is outside the supported range.")
                }
            }
        }
        if let animation = node.animation {
            guard is3D,
                  animation.translation.values.allSatisfy({ $0.isFinite && abs($0) <= 20 }),
                  animation.rotation.values.allSatisfy({ $0.isFinite && abs($0) <= 3_600 }),
                  animation.duration.isFinite, (0.25...30).contains(animation.duration) else {
                throw VisualValidationError.invalid("Invalid animation.")
            }
        }
        if node.shape == .mesh {
            guard (3...4_096).contains(node.vertices.count), (3...12_288).contains(node.triangles.count), node.triangles.count.isMultiple(of: 3),
                  node.vertices.allSatisfy({ $0.values.allSatisfy { $0.isFinite && abs($0) <= 20 } }),
                  node.triangles.allSatisfy({ node.vertices.indices.contains($0) }) else {
                throw VisualValidationError.invalid("Invalid triangle mesh.")
            }
        } else if !node.vertices.isEmpty || !node.triangles.isEmpty {
            throw VisualValidationError.invalid("Only mesh objects accept vertices and triangles.")
        }
    }
}
