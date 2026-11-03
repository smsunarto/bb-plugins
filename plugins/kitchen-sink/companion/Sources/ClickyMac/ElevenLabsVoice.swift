import AVFoundation
import ClickyCore
import Foundation
import Observation

private func voiceMessage(_ message: URLSessionWebSocketTask.Message) throws -> VoiceMessage {
    switch message {
    case .data(let data): try RealtimeVoiceProtocol.decode(data)
    case .string(let text): try RealtimeVoiceProtocol.decode(Data(text.utf8))
    @unknown default: throw VoiceProtocolError.invalidMessage
    }
}

@MainActor final class VoiceTranscriptionSession {
    private let socket: URLSessionWebSocketTask
    private var reader: Task<Void, Never>?
    private var sender: Task<Void, any Error>?
    private var ready = false
    private var finishing = false
    private var finalized = false
    private var failure: (any Error)?
    private(set) var transcript = TranscriptAccumulator()
    var onPreview: ((String) -> Void)?
    var onFailure: (((any Error)) -> Void)?

    init(key: String, url: URL = RealtimeVoiceProtocol.transcriptionURL()) {
        var request = URLRequest(url: url)
        request.setValue(key, forHTTPHeaderField: "xi-api-key")
        socket = URLSession.shared.webSocketTask(with: request)
        socket.maximumMessageSize = 2 * 1024 * 1024
    }
    func start(audio: AsyncThrowingStream<Data, any Error>) async throws {
        socket.resume()
        reader = Task { [weak self] in
            guard let self else { return }
            do {
                while !Task.isCancelled {
                    let message = try voiceMessage(await socket.receive())
                    if message == .ready { ready = true }
                    transcript.observe(message); onPreview?(transcript.preview)
                    if case .committed = message, finishing { finalized = true }
                }
            } catch { if !Task.isCancelled { fail(error) } }
        }
        sender = Task { [weak self] in
            guard let self else { throw CancellationError() }
            do {
                try await waitUntil { self.ready }
                // Keep one real audio buffer for the release-time commit.
                var last: Data?
                for try await chunk in audio {
                    try Task.checkCancellation()
                    if let last { try await socket.send(.string(RealtimeVoiceProtocol.audio(last))) }
                    last = chunk
                }
                guard let last, !last.isEmpty else { throw VoiceProtocolError.noSpeech }
                finishing = true
                try await socket.send(.string(RealtimeVoiceProtocol.audio(last, commit: true)))
            } catch { if !Task.isCancelled { fail(error) }; throw error }
        }
        try await waitUntil { self.ready }
    }
    func finish() async throws -> String {
        guard let sender else { throw CancellationError() }
        // The socket is cancelled by cancel(), including a stalled send.
        let deadline = Task { [weak self] in
            try? await Task.sleep(for: .seconds(12))
            if !Task.isCancelled { self?.fail(VoiceProtocolError.timedOut) }
        }
        defer { deadline.cancel(); cancel() }
        do {
            try await sender.value
            try await waitUntil { self.finalized }
            guard !transcript.committed.isEmpty else { throw VoiceProtocolError.noSpeech }
            return transcript.committed
        } catch {
            if !(error is CancellationError) { fail(error) }
            throw error
        }
    }
    private func waitUntil(_ condition: () -> Bool) async throws {
        let until = Date().addingTimeInterval(10)
        while !condition() {
            try Task.checkCancellation()
            if let failure { throw failure }
            guard Date() < until else { throw VoiceProtocolError.timedOut }
            try await Task.sleep(for: .milliseconds(25))
        }
        if let failure { throw failure }
    }
    private func fail(_ error: any Error) {
        guard failure == nil else { return }
        failure = error
        onFailure?(error)
        socket.cancel(with: .goingAway, reason: nil)
    }
    func cancel() {
        reader?.cancel(); sender?.cancel()
        socket.cancel(with: .goingAway, reason: nil)
    }
}

@MainActor final class VoicePlayback {
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let format = AVAudioFormat(standardFormatWithSampleRate: 24000, channels: 1)!
    private var started = false
    private var generation = UUID()
    private(set) var pendingFrames = 0
    private var decoder = PCM16Decoder()

    func append(_ data: Data) throws {
        let samples = decoder.decode(data)
        guard !samples.isEmpty else { return }
        guard pendingFrames + samples.count <= 24000 * 120 else { throw VoiceProtocolError.overflow }
        if !started {
            engine.attach(player); engine.connect(player, to: engine.mainMixerNode, format: format)
            try engine.start(); player.play(); started = true
        }
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)),
              let output = buffer.floatChannelData?[0] else { throw VoiceProtocolError.invalidMessage }
        buffer.frameLength = AVAudioFrameCount(samples.count)
        samples.withUnsafeBufferPointer { output.update(from: $0.baseAddress!, count: $0.count) }
        pendingFrames += samples.count
        let current = generation
        player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { @Sendable [weak self] _ in
            Task { @MainActor in
                guard let self, self.generation == current else { return }
                self.pendingFrames = max(0, self.pendingFrames - samples.count)
            }
        }
    }
    func drain() async throws {
        let until = Date().addingTimeInterval(125)
        while pendingFrames > 0 {
            try Task.checkCancellation()
            guard Date() < until else { throw VoiceProtocolError.timedOut }
            try await Task.sleep(for: .milliseconds(50))
        }
    }
    func stop() {
        generation = UUID(); player.stop(); engine.stop(); pendingFrames = 0
    }
}

@MainActor final class VoiceSpeechSession {
    private enum Command { case text(String), keepAlive, finish }
    private let socket: URLSessionWebSocketTask
    private let playback = VoicePlayback()
    private let commands: AsyncStream<Command>
    private let input: AsyncStream<Command>.Continuation
    private var writer: Task<Void, Never>?
    private var reader: Task<Void, Never>?
    private var keepAlive: Task<Void, Never>?
    private var deadline: Task<Void, Never>?
    private var connectionDeadline: Task<Void, Never>?
    private var receivedAudio = false
    private var finishedInput = false
    private var stopped = false
    var onDone: (() -> Void)?
    var onFailure: (((any Error)) -> Void)?

    init(key: String, voiceID: String, url: URL? = nil) throws {
        var request = URLRequest(url: try url ?? RealtimeVoiceProtocol.speechURL(voiceID: voiceID))
        request.setValue(key, forHTTPHeaderField: "xi-api-key")
        socket = URLSession.shared.webSocketTask(with: request)
        socket.maximumMessageSize = 2 * 1024 * 1024
        (commands, input) = AsyncStream.makeStream(bufferingPolicy: .bufferingOldest(2048))
    }
    func start() {
        socket.resume()
        connectionDeadline = Task { [weak self] in
            try? await Task.sleep(for: .seconds(15))
            guard !Task.isCancelled, let self, !receivedAudio else { return }
            fail(VoiceProtocolError.timedOut)
        }
        writer = Task { [weak self] in
            guard let self else { return }
            do {
                try await send(.string(RealtimeVoiceProtocol.json(["text": " ", "voice_settings": ["stability": 0.5, "similarity_boost": 0.75]])))
                for await command in commands {
                    try Task.checkCancellation()
                    let value: [String: Any]
                    switch command {
                    case .text(let text): value = ["text": text + " ", "flush": true]
                    case .keepAlive: value = ["text": " "]
                    case .finish: value = ["text": ""]
                    }
                    try await send(.string(RealtimeVoiceProtocol.json(value)))
                }
            } catch { if !Task.isCancelled { fail(error) } }
        }
        reader = Task { [weak self] in
            guard let self else { return }
            do {
                while !Task.isCancelled {
                    let message = try voiceMessage(await socket.receive())
                    var final = false
                    switch message {
                    case .audio(let data, let done): receivedAudio = true; connectionDeadline?.cancel(); try playback.append(data); final = done
                    case .finished: final = true
                    default: break
                    }
                    if final {
                        try await playback.drain()
                        guard !stopped else { return }
                        stop(); onDone?(); return
                    }
                }
            } catch { if !Task.isCancelled { fail(error) } }
        }
        keepAlive = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(10))
                guard !Task.isCancelled, let self, !finishedInput, !stopped else { return }
                enqueue(.keepAlive)
            }
        }
    }
    func append(_ text: String) { if !finishedInput, !stopped { enqueue(.text(text)) } }
    func finish() {
        guard !finishedInput, !stopped else { return }
        finishedInput = true; keepAlive?.cancel(); enqueue(.finish); input.finish()
        deadline = Task { [weak self] in
            try? await Task.sleep(for: .seconds(150))
            if !Task.isCancelled { self?.fail(VoiceProtocolError.timedOut) }
        }
    }
    private func send(_ message: URLSessionWebSocketTask.Message) async throws {
        let timeout = Task { [socket] in
            try? await Task.sleep(for: .seconds(10))
            if !Task.isCancelled { socket.cancel(with: .goingAway, reason: nil) }
        }
        defer { timeout.cancel() }
        try await socket.send(message)
    }
    private func enqueue(_ command: Command) {
        if case .dropped = input.yield(command) { fail(VoiceProtocolError.overflow) }
    }
    private func fail(_ error: any Error) { guard !stopped else { return }; stop(); onFailure?(error) }
    func stop() {
        stopped = true
        writer?.cancel(); reader?.cancel(); keepAlive?.cancel(); connectionDeadline?.cancel(); deadline?.cancel(); input.finish()
        socket.cancel(with: .goingAway, reason: nil); playback.stop()
    }
}

@Observable @MainActor final class ElevenLabsVoice {
    enum State { case idle, connecting, listening, finalizing, speaking }
    private(set) var state: State = .idle
    private(set) var preview = ""
    var onInputFailure: ((String, String) -> Void)?
    var onSpeechFailure: ((String) -> Void)?
    private var capture: VoiceCapture?
    private var transcription: VoiceTranscriptionSession?
    private var speech: VoiceSpeechSession?
    private var inputGeneration = UUID()
    private var speechGeneration = UUID()
    var speaking: Bool { speech != nil }
    var hasLiveCapture: Bool { capture != nil }
    func releaseCapture() { capture?.finish() }
    private func key() throws -> String {
        guard let key = try VoiceKeychain.read() else { throw VoiceProtocolError.provider("missing_key") }
        return key
    }
    func startListening() async throws {
        cancelInput(); stopSpeaking()
        let generation = inputGeneration
        let key = try key()
        state = .connecting; preview = ""
        let allowed = await AVCaptureDevice.requestAccess(for: .audio)
        guard generation == inputGeneration else { throw CancellationError() }
        guard allowed else { state = .idle; throw DesktopServiceError.microphoneDenied }
        do {
            let capture = VoiceCapture(); self.capture = capture
            let session = VoiceTranscriptionSession(key: key); transcription = session
            session.onPreview = { [weak self] text in guard self?.inputGeneration == generation else { return }; self?.preview = text }
            session.onFailure = { [weak self] error in
                guard let self, inputGeneration == generation else { return }
                let partial = preview; cancelInput(); onInputFailure?(error.localizedDescription, partial)
            }
            try await session.start(audio: capture.start())
            guard inputGeneration == generation else { throw CancellationError() }
            state = .listening
        } catch { if inputGeneration == generation { cancelInput() }; throw error }
    }
    func finishListening() async throws -> String {
        guard let capture, let transcription else { throw CancellationError() }
        let generation = inputGeneration
        state = .finalizing; capture.finish(); self.capture = nil
        defer { if generation == inputGeneration { self.transcription = nil; state = .idle } }
        let result = try await transcription.finish()
        guard generation == inputGeneration else { throw CancellationError() }
        return result
    }
    func cancelInput() {
        inputGeneration = UUID(); capture?.cancel(); capture = nil
        transcription?.cancel(); transcription = nil; state = .idle
    }
    func startSpeaking(voiceID: String) throws {
        stopSpeaking()
        let generation = speechGeneration
        let session = try VoiceSpeechSession(key: key(), voiceID: voiceID)
        speech = session; state = .speaking
        session.onDone = { [weak self] in guard let self, speechGeneration == generation else { return }; speech = nil; state = .idle }
        session.onFailure = { [weak self] error in
            guard let self, speechGeneration == generation else { return }
            speech = nil; state = .idle; onSpeechFailure?(error.localizedDescription)
        }
        session.start()
    }
    func appendSpeech(_ text: String) { speech?.append(text) }
    func finishSpeech() { speech?.finish() }
    func stopSpeaking() { speechGeneration = UUID(); speech?.stop(); speech = nil; if state == .speaking { state = .idle } }
    func shutdown() { cancelInput(); stopSpeaking() }
}
