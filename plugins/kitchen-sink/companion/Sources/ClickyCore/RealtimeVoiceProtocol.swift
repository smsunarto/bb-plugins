import Foundation

public enum RealtimeVoiceProtocol {
    public static let maxSpokenCharacters = 1500
    public static let defaultVoiceID = "JBFqnCBsd6RMkjVDRZzb"
    public static func transcriptionURL() -> URL {
        URL(string: "wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&audio_format=pcm_16000&commit_strategy=manual")!
    }
    public static func speechURL(voiceID: String) throws -> URL {
        guard !voiceID.isEmpty, voiceID.count <= 128,
              voiceID.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-") }) else { throw VoiceProtocolError.invalidVoice }
        return URL(string: "wss://api.elevenlabs.io/v1/text-to-speech/\(voiceID)/stream-input?model_id=eleven_flash_v2_5&output_format=pcm_24000&auto_mode=true&inactivity_timeout=180")!
    }
    public static func audio(_ data: Data, commit: Bool = false) throws -> String {
        try json(["message_type": "input_audio_chunk", "audio_base_64": data.base64EncodedString(), "sample_rate": 16000, "commit": commit])
    }
    public static func json(_ value: [String: Any]) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value), as: UTF8.self)
    }
    public static func decode(_ data: Data) throws -> VoiceMessage {
        guard data.count <= 2 * 1024 * 1024,
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { throw VoiceProtocolError.invalidMessage }
        if let type = object["message_type"] as? String {
            switch type {
            case "session_started": return .ready
            case "partial_transcript": return .partial(object["text"] as? String ?? "")
            case "committed_transcript", "committed_transcript_with_timestamps": return .committed(object["text"] as? String ?? "")
            default:
                if type.contains("error") || ["quota_exceeded", "rate_limited", "resource_exhausted", "commit_throttled", "insufficient_audio_activity"].contains(type) { throw VoiceProtocolError.provider(type) }
                return .other
            }
        }
        if object["error"] != nil { throw VoiceProtocolError.provider("speech_error") }
        if let encoded = object["audio"] as? String {
            guard let audio = Data(base64Encoded: encoded) else { throw VoiceProtocolError.invalidMessage }
            return .audio(audio, final: object["isFinal"] as? Bool == true)
        }
        if object["isFinal"] as? Bool == true { return .finished }
        return .other
    }
}

public enum VoiceMessage: Equatable, Sendable {
    case ready, partial(String), committed(String), audio(Data, final: Bool), finished, other
}
public enum VoiceProtocolError: LocalizedError, Sendable {
    case invalidVoice, invalidMessage, provider(String), timedOut, overflow, noSpeech, deviceChanged
    public var errorDescription: String? {
        switch self {
        case .invalidVoice: "Enter a valid ElevenLabs voice ID."
        case .invalidMessage: "ElevenLabs returned an unsupported voice message."
        case .timedOut: "The ElevenLabs voice connection timed out. Try again."
        case .overflow: "The voice connection could not keep up. Please try a shorter question."
        case .noSpeech: "No speech was detected. Hold the shortcut and ask again."
        case .deviceChanged: "The audio device changed. Hold the shortcut to ask again."
        case .provider(let code):
            switch code {
            case "missing_key": "Add your ElevenLabs API key in Clicky Settings."
            case "auth_error": "ElevenLabs rejected the API key. Check it in Settings."
            case "quota_exceeded", "rate_limited", "resource_exhausted": "ElevenLabs voice quota or rate limit reached."
            default: "ElevenLabs could not complete this voice session (\(code.filter { $0.isASCII && ($0.isLetter || $0 == "_") }.prefix(50)))."
            }
        }
    }
}

public struct TranscriptAccumulator: Sendable {
    public private(set) var segments: [String] = []
    public private(set) var partial = ""
    public init() {}
    public var committed: String { segments.joined(separator: " ") }
    public var preview: String { ([committed, partial].filter { !$0.isEmpty }).joined(separator: " ") }
    public mutating func observe(_ message: VoiceMessage) {
        switch message {
        case .partial(let text): partial = text
        case .committed(let text):
            if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { segments.append(text) }
            partial = ""
        default: break
        }
    }
}

/// Speak only closed lines outside code fences. An incomplete marker or fence can
/// never escape into audio, regardless of the provider's delta boundaries.
public struct SpeechAccumulator: Sendable {
    private var emitted: [String: String] = [:]
    public private(set) var charactersSent = 0
    public init() {}
    public mutating func consume(itemID: String, text: String, complete: Bool) -> [String] {
        let stable = Self.stableText(text, complete: complete)
        let prefix = emitted[itemID] ?? ""
        // Already spoken text cannot be taken back. Suppress a corrected item
        // rather than replaying it or applying an offset into unrelated text.
        guard stable.hasPrefix(prefix) else { emitted[itemID] = stable; return [] }
        let tail = String(stable.dropFirst(prefix.count))
        emitted[itemID] = stable
        guard !tail.isEmpty, charactersSent < RealtimeVoiceProtocol.maxSpokenCharacters else { return [] }
        let spoken = tail.replacingOccurrences(of: #"!?\[([^\]]*)\]\([^)]*\)"#, with: "$1", options: .regularExpression)
            .replacingOccurrences(of: #"[`*_#>]"#, with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !spoken.isEmpty else { return [] }
        var result: [String] = []
        var remaining = String(spoken.prefix(RealtimeVoiceProtocol.maxSpokenCharacters - charactersSent))
        charactersSent += remaining.count
        while !remaining.isEmpty {
            let end = remaining.index(remaining.startIndex, offsetBy: min(320, remaining.count))
            result.append(String(remaining[..<end])); remaining = String(remaining[end...])
        }
        return result
    }
    private static func stableText(_ text: String, complete: Bool) -> String {
        var fence: (delimiter: Character, length: Int)?
        var lines = text.components(separatedBy: "\n")
        if !complete { lines.removeLast() }
        var result = ""
        for line in lines {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if let first = trimmed.first, first == "`" || first == "~" {
                let run = trimmed.prefix(while: { $0 == first }).count
                if run >= 3 {
                    if let opening = fence {
                        let suffix = trimmed.dropFirst(run).trimmingCharacters(in: .whitespaces)
                        if first == opening.delimiter, run >= opening.length, suffix.isEmpty { fence = nil }
                    } else { fence = (first, run) }
                    continue
                }
            }
            guard fence == nil else { continue }
            // Only complete bracketed markers/links are eligible to be spoken.
            var depth = 0
            for c in line { if c == "[" { depth += 1 }; if c == "]" { depth = max(0, depth - 1) } }
            guard depth == 0 else { continue }
            let clean = line.replacingOccurrences(of: #"\[POINT:[^\]]*\]"#, with: "", options: .regularExpression)
            result += clean.trimmingCharacters(in: .whitespacesAndNewlines) + "\n"
        }
        return result
    }
}

/// WebSocket audio frames may split a little-endian Int16 sample.
public struct PCM16Decoder: Sendable {
    private var pending: UInt8?
    public init() {}
    public mutating func decode(_ data: Data) -> [Float] {
        var bytes = Array(data)
        if let pending { bytes.insert(pending, at: 0) }
        pending = bytes.count.isMultiple(of: 2) ? nil : bytes.removeLast()
        return stride(from: 0, to: bytes.count, by: 2).map {
            Float(Int16(bitPattern: UInt16(bytes[$0]) | UInt16(bytes[$0 + 1]) << 8)) / 32768
        }
    }
}
