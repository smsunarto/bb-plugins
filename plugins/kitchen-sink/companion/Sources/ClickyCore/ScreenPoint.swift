import Foundation

/// A read-only visual hint, in normalized image coordinates (top-left is 0,0).
public struct ScreenPoint: Equatable, Sendable {
    public let x: Double
    public let y: Double
    public let label: String

    public init?(x: Double, y: Double, label: String) {
        guard x.isFinite, y.isFinite, (0...1000).contains(x), (0...1000).contains(y) else { return nil }
        let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= 100 else { return nil }
        self.x = x
        self.y = y
        self.label = trimmed
    }

    /// Maps image coordinates into a bottom-left-origin coordinate space.
    public func position(width: Double, height: Double, originX: Double = 0, originY: Double = 0) -> (x: Double, y: Double) {
        (x: originX + width * x / 1000, y: originY + height * (1 - y / 1000))
    }

    /// Only valid markers are removed; malformed output remains visible as text.
    public static func parse(in response: String) -> (text: String, points: [ScreenPoint]) {
        let pattern = #/\[POINT:(\d{1,4}(?:\.\d+)?),(\d{1,4}(?:\.\d+)?):([^\]\n]{1,100})\]/#
        var text = response
        var points: [ScreenPoint] = []
        for match in response.matches(of: pattern).reversed() {
            guard let x = Double(match.1), let y = Double(match.2),
                  let point = ScreenPoint(x: x, y: y, label: String(match.3)) else { continue }
            points.append(point)
            text.removeSubrange(match.range)
        }
        return (text.trimmingCharacters(in: .whitespacesAndNewlines), Array(points.reversed().prefix(8)))
    }
}
