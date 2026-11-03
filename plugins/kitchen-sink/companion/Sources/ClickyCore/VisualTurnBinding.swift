import Foundation

/// Correlates the companion's request marker with BB's authoritative input acceptance.
/// Turn starts and model output cannot select the visual's owning turn.
public struct VisualTurnBinding: Codable, Equatable, Sendable {
    public let nonce: String
    public let afterSequence: Int
    public private(set) var clientRequestID: String?
    public private(set) var turnID: String?

    public init(nonce: String, afterSequence: Int) {
        self.nonce = nonce
        self.afterSequence = afterSequence
    }

    public mutating func observe(_ event: BBEvent) {
        guard event.seq > afterSequence else { return }
        switch event.kind {
        case let .userMessage(text):
            guard clientRequestID == nil, let requestID = event.clientRequestID, !requestID.isEmpty else { return }
            let marker = "Clicky request: \(nonce)"
            let hasMarker = text.components(separatedBy: "\n").contains { line in
                // JSON text may retain CRLF, but indentation or suffixes are not exact markers.
                (line.hasSuffix("\r") ? String(line.dropLast()) : line) == marker
            }
            if hasMarker { clientRequestID = requestID }
        case let .turnInputAccepted(requestID):
            guard let boundRequestID = clientRequestID, requestID == boundRequestID,
                  let acceptedTurnID = event.turnID, !acceptedTurnID.isEmpty else { return }
            turnID = acceptedTurnID
        default:
            break
        }
    }

    public func matches(_ event: BBEvent) -> Bool {
        guard event.seq > afterSequence, let turnID, let eventTurnID = event.turnID else { return false }
        return turnID == eventTurnID
    }
}
