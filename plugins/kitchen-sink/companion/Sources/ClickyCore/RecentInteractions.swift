import Foundation

public struct RecentInteraction: Codable, Equatable, Sendable {
    public let id: String
    public let requestedAt: Date
    public let serverURL: String
    public let threadID: String?
    public let question: String
    public let answer: String
    public let outcome: String
    public let context: String?

    public init(id: String, requestedAt: Date, serverURL: String, threadID: String?, question: String, answer: String, outcome: String, context: String?) {
        self.id = id; self.requestedAt = requestedAt; self.serverURL = serverURL; self.threadID = threadID
        self.question = question; self.answer = answer; self.outcome = outcome; self.context = context
    }
}

public enum InteractionHistory {
    public static func recent(_ entries: [RecentInteraction], before now: Date, serverURL: String, excluding id: String) -> [RecentInteraction] {
        entries.filter { $0.id != id && $0.serverURL == serverURL && $0.requestedAt <= now && now.timeIntervalSince($0.requestedAt) <= 600 }
            .sorted { $0.requestedAt == $1.requestedAt ? $0.id < $1.id : $0.requestedAt < $1.requestedAt }.suffix(5).map { $0 }
    }

    public static func promptJSON(_ entries: [RecentInteraction]) throws -> String {
        struct Transcript: Encodable {
            let requestedAt: Date
            let threadID: String?
            let question: String
            let answer: String
            let outcome: String
            let context: String?
            let truncated: Bool
        }
        let values = entries.map { entry in
            let answer = ScreenPoint.parse(in: VisualStream.visibleText(entry.answer)).text
            return Transcript(requestedAt: entry.requestedAt, threadID: entry.threadID,
                question: String(entry.question.prefix(4000)), answer: String(answer.prefix(8000)), outcome: entry.outcome,
                context: entry.context.map { String($0.prefix(500)) }, truncated: entry.question.count > 4000 || answer.count > 8000)
        }
        let encoder = JSONEncoder(); encoder.dateEncodingStrategy = .iso8601; encoder.outputFormatting = [.sortedKeys]
        return String(decoding: try encoder.encode(values), as: UTF8.self)
    }
}
