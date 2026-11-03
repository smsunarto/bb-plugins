import Foundation

public struct BBConfiguration: Codable, Sendable, Equatable {
    public var executablePath: String
    public var runtimeExecutablePath: String?
    public var serverURL: String?
    public var timeoutSeconds: Double

    public init() {
        self.init(executablePath: Self.defaultExecutablePath, runtimeExecutablePath: Self.defaultRuntimeExecutablePath)
    }

    /// Explicit CLI paths execute directly unless their runtime is also supplied.
    public init(executablePath: String, serverURL: String? = nil, timeoutSeconds: Double = 30, runtimeExecutablePath: String? = nil) {
        self.executablePath = executablePath
        self.runtimeExecutablePath = runtimeExecutablePath
        self.serverURL = serverURL
        self.timeoutSeconds = timeoutSeconds
    }

    private static var rawCLIPath: String? {
        let candidates = [
            FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".bb/npm/lib/node_modules/bb-app/host-daemon/dist/bb").path,
            "/Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/host-daemon/dist/bb"
        ]
        return candidates.first { FileManager.default.isReadableFile(atPath: $0) }
    }

    public static var defaultExecutablePath: String {
        rawCLIPath ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".bb/bin/bb").path
    }

    public static var defaultRuntimeExecutablePath: String? {
        let runtime = "/Applications/bb.app/Contents/MacOS/bb"
        return rawCLIPath != nil && FileManager.default.isExecutableFile(atPath: runtime) ? runtime : nil
    }
}

public enum BBTarget: Codable, Sendable, Equatable {
    case environment(projectID: String, environmentID: String)
    case personal(hostID: String)

    public var projectID: String {
        switch self {
        case .environment(let projectID, _): projectID
        case .personal: "proj_personal"
        }
    }
}

public struct BBProject: Decodable, Sendable, Identifiable {
    public let id: String
    public let name: String
}

public struct BBHost: Decodable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let status: String
}

public struct BBEnvironment: Decodable, Sendable, Identifiable {
    public let id: String
    public let projectId: String
    public let hostId: String
    public let name: String?
    public let path: String?
    public let status: String
}

public struct BBThread: Decodable, Sendable, Identifiable {
    public let id: String
    public let projectId: String
    public let environmentId: String?
    public let title: String?
    public let titleFallback: String?
    public let status: String
    public let hasPendingInteraction: Bool?
    public let queuedWork: String?
    public let updatedAt: Double?
    public let archivedAt: Double?
    private let runtime: Runtime?

    public var displayStatus: String { runtime?.displayStatus ?? status }
    public var hasQueuedWork: Bool { queuedWork != nil && queuedWork != "none" }
    public var displayTitle: String { title ?? titleFallback ?? "Conversation" }
    private struct Runtime: Decodable, Sendable { let displayStatus: String }
}

public struct BBSendReceipt: Decodable, Sendable {
    public let threadId: String
    public let ok: Bool
    public let delivery: String?
}

/// A sequence remains visible even for ignored events so pagination never stalls.
public struct BBEvent: Decodable, Sendable, Identifiable {
    public let id: String
    public let seq: Int
    public let turnID: String?
    /// The server request ID recorded with a user message, distinct from its eventual provider turn.
    public let clientRequestID: String?
    public let kind: Kind

    public enum Kind: Sendable, Equatable {
        case userMessage(String)
        case assistantDelta(itemID: String, text: String)
        case assistantMessage(itemID: String, text: String)
        case turnStarted(isRoot: Bool)
        case turnInputAccepted(clientRequestID: String)
        case turnCompleted(status: String, error: String?)
        case threadInterrupted(reason: String, cause: String?)
        case other
    }

    private enum Keys: String, CodingKey { case id, seq, scope, type, data }
    private enum DataKeys: String, CodingKey { case input, item, itemId, delta, status, error, parentToolCallId, reason, cause, requestId, clientRequestId }
    private struct Scope: Decodable { let turnId: String? }
    private struct Input: Decodable { let type: String; let text: String? }
    private struct ItemHeader: Decodable { let type: String }
    private struct Item: Decodable {
        let id: String
        let type: String
        let text: String?
        let parentToolCallId: String?
    }
    private struct TurnError: Decodable { let message: String }

    public init(from decoder: any Decoder) throws {
        let fields = try decoder.container(keyedBy: Keys.self)
        id = try fields.decode(String.self, forKey: .id)
        seq = try fields.decode(Int.self, forKey: .seq)
        turnID = try fields.decodeIfPresent(Scope.self, forKey: .scope)?.turnId
        let type = try fields.decode(String.self, forKey: .type)
        // Tool output and reasoning can have arbitrary data. Do not decode them.
        guard ["client/turn/requested", "item/agentMessage/delta", "item/completed", "turn/started", "turn/input/accepted", "turn/completed", "system/thread/interrupted"].contains(type) else {
            clientRequestID = nil
            kind = .other
            return
        }
        let data = try fields.nestedContainer(keyedBy: DataKeys.self, forKey: .data)
        let parentToolCallID = try data.decodeIfPresent(String.self, forKey: .parentToolCallId)
        guard type == "turn/started" || parentToolCallID == nil else {
            clientRequestID = nil
            kind = .other
            return
        }
        clientRequestID = type == "client/turn/requested" ? try data.decodeIfPresent(String.self, forKey: .requestId) : nil
        switch type {
        case "client/turn/requested":
            let input = try data.decode([Input].self, forKey: .input)
            kind = .userMessage(input.filter { $0.type == "text" }.compactMap(\.text).joined(separator: "\n"))
        case "item/agentMessage/delta":
            kind = .assistantDelta(itemID: try data.decode(String.self, forKey: .itemId), text: try data.decode(String.self, forKey: .delta))
        case "item/completed":
            // Unknown tool item representations must not break chat pagination.
            guard let header = try? data.decode(ItemHeader.self, forKey: .item), header.type == "agentMessage" else {
                kind = .other
                return
            }
            let item = try data.decode(Item.self, forKey: .item)
            if item.parentToolCallId == nil, let text = item.text {
                kind = .assistantMessage(itemID: item.id, text: text)
            } else {
                kind = .other
            }
        case "turn/started":
            kind = .turnStarted(isRoot: parentToolCallID == nil)
        case "turn/input/accepted":
            kind = .turnInputAccepted(clientRequestID: try data.decode(String.self, forKey: .clientRequestId))
        case "turn/completed":
            kind = .turnCompleted(status: try data.decode(String.self, forKey: .status), error: try data.decodeIfPresent(TurnError.self, forKey: .error)?.message)
        case "system/thread/interrupted":
            kind = .threadInterrupted(reason: try data.decode(String.self, forKey: .reason), cause: try data.decodeIfPresent(String.self, forKey: .cause))
        default:
            kind = .other
        }
    }
}

public enum BBClientError: Error, LocalizedError, Sendable {
    case invalidConfiguration(String)
    case commandFailed(String, mayHaveSucceeded: Bool)
    case timedOut(mayHaveSucceeded: Bool)
    case invalidResponse
    case responseTooLarge

    public var errorDescription: String? {
        switch self {
        case .invalidConfiguration(let reason): reason
        case .commandFailed(let reason, let uncertain): reason + (uncertain ? " The request may have reached BB. Refresh before sending it again." : "")
        case .timedOut(let uncertain): "BB did not respond in time." + (uncertain ? " The request may have reached BB. Refresh before sending it again." : " Check your connection and try refreshing.")
        case .invalidResponse: "BB returned an unreadable response. Check that your BB app and CLI are up to date."
        case .responseTooLarge: "BB returned more data than this view can load. Open the conversation in BB."
        }
    }
}
