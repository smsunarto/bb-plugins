@preconcurrency import AVFoundation
import ClickyCore
import Foundation

/// The tap runs on Core Audio's thread, never the main actor. The converter is
/// serialized with stop/flush, and no UI state is touched by the tap.
nonisolated final class VoiceCapture: @unchecked Sendable {
    private let engine = AVAudioEngine()
    private let lock = NSLock()
    private var converter: AVAudioConverter?
    private var outputFormat: AVAudioFormat?
    private var continuation: AsyncThrowingStream<Data, any Error>.Continuation?
    private var observer: NSObjectProtocol?
    private var installed = false
    private var capturedBytes = 0

    func start() throws -> AsyncThrowingStream<Data, any Error> {
        let input = engine.inputNode
        let source = input.outputFormat(forBus: 0)
        guard source.sampleRate > 0, source.channelCount > 0,
              let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true),
              let converter = AVAudioConverter(from: source, to: format) else { throw VoiceProtocolError.deviceChanged }
        self.converter = converter; outputFormat = format
        let (stream, continuation) = AsyncThrowingStream<Data, any Error>.makeStream(bufferingPolicy: .unbounded)
        self.continuation = continuation
        input.installTap(onBus: 0, bufferSize: 2048, format: source) { @Sendable [weak self] buffer, _ in
            self?.convert(buffer)
        }
        installed = true
        observer = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { @Sendable _ in
            continuation.finish(throwing: VoiceProtocolError.deviceChanged)
        }
        do { engine.prepare(); try engine.start() }
        catch { cancel(); throw error }
        return stream
    }
    private func convert(_ input: AVAudioPCMBuffer?) {
        lock.withLock {
            guard let converter, let outputFormat, let continuation else { return }
            let capacity = AVAudioFrameCount(ceil(Double(input?.frameLength ?? 0) * 16000 / (input?.format.sampleRate ?? 16000))) + 128
            guard let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: max(128, capacity)) else { return }
            let source = ConverterInput(input)
            var error: NSError?
            let status = converter.convert(to: output, error: &error) { _, state in
                source.next(state)
            }
            if let error { continuation.finish(throwing: error); return }
            if output.frameLength > 0, let samples = output.int16ChannelData?[0] {
                let data = Data(bytes: samples, count: Int(output.frameLength) * 2)
                // The whole 30-second hold fits while a connection opens,
                // independent of the input device's tap size or sample rate.
                capturedBytes += data.count
                guard capturedBytes <= 32000 * 31 else { continuation.finish(throwing: VoiceProtocolError.overflow); return }
                if case .dropped = continuation.yield(data) { continuation.finish(throwing: VoiceProtocolError.overflow) }
            }
            if status == .error { continuation.finish(throwing: VoiceProtocolError.deviceChanged) }
        }
    }
    func finish() {
        detach()
        convert(nil)
        lock.withLock { continuation?.finish(); continuation = nil; converter = nil }
    }
    func cancel() {
        detach()
        lock.withLock { continuation?.finish(throwing: CancellationError()); continuation = nil; converter = nil }
    }
    private func detach() {
        if let observer { NotificationCenter.default.removeObserver(observer); self.observer = nil }
        if installed { engine.inputNode.removeTap(onBus: 0); installed = false }
        engine.stop()
    }
}

// AVAudioConverter invokes this synchronously under VoiceCapture's lock.
nonisolated private final class ConverterInput: @unchecked Sendable {
    let buffer: AVAudioPCMBuffer?
    var supplied = false
    init(_ buffer: AVAudioPCMBuffer?) { self.buffer = buffer }
    func next(_ state: UnsafeMutablePointer<AVAudioConverterInputStatus>) -> AVAudioPCMBuffer? {
        if let buffer, !supplied { supplied = true; state.pointee = .haveData; return buffer }
        state.pointee = buffer == nil ? .endOfStream : .noDataNow
        return nil
    }
}
