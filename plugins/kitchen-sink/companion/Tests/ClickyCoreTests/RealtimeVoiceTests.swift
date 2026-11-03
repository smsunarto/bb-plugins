import Foundation
import Testing
@testable import ClickyCore

struct RealtimeVoiceTests {
    @Test func routesAndAuthenticationStaySeparate() throws {
        let input = RealtimeVoiceProtocol.transcriptionURL()
        #expect(input.scheme == "wss")
        #expect(input.query?.contains("scribe_v2_realtime") == true)
        #expect(input.query?.contains("pcm_16000") == true)
        let output = try RealtimeVoiceProtocol.speechURL(voiceID: RealtimeVoiceProtocol.defaultVoiceID)
        #expect(output.query?.contains("pcm_24000") == true)
        #expect(output.query?.contains("inactivity_timeout=180") == true)
        #expect(throws: VoiceProtocolError.self) { try RealtimeVoiceProtocol.speechURL(voiceID: "../other?key=secret") }
    }
    @Test func realAudioCommit() throws {
        let audio = Data([0x01, 0x00, 0xff, 0x7f])
        let message = try JSONSerialization.jsonObject(with: Data(RealtimeVoiceProtocol.audio(audio, commit: true).utf8)) as! [String: Any]
        #expect(message["commit"] as? Bool == true)
        #expect(message["sample_rate"] as? Int == 16000)
        #expect(message["audio_base_64"] as? String == audio.base64EncodedString())
    }
    @Test func commitsAccumulateBeforeAndAfterRelease() {
        var transcript = TranscriptAccumulator()
        transcript.observe(.partial("first part"))
        transcript.observe(.committed("first part"))
        #expect(transcript.committed == "first part")
        transcript.observe(.partial("second part"))
        #expect(transcript.preview == "first part second part")
        transcript.observe(.committed("second part"))
        #expect(transcript.committed == "first part second part")
        #expect(transcript.partial.isEmpty)
    }
    @Test func neverSpeakSplitVisualOrPointProtocol() {
        let text = "Here is the answer.\n\n```clicky-visual\n{\"op\":\"scene\",\"kind\":\"diagram\"}\n```\nClick this [POINT:120,300:Button].\nThe end."
        for cut in 0...text.count {
            var accumulator = SpeechAccumulator()
            let prefix = String(text.prefix(cut))
            let first = accumulator.consume(itemID: "a", text: prefix, complete: false)
            let last = accumulator.consume(itemID: "a", text: text, complete: true)
            let spoken = (first + last).joined(separator: " ")
            #expect(!spoken.contains("clicky-visual"))
            #expect(!spoken.contains("[POINT"))
            #expect(!spoken.contains("`"))
            #expect(!spoken.contains("\"op\""))
            #expect(spoken.contains("Here is the answer."))
            #expect(spoken.contains("The end."))
        }
    }
    @Test func duplicateCompletionAndReplacementNeverReplay() {
        var accumulator = SpeechAccumulator()
        #expect(accumulator.consume(itemID: "a", text: "First.\n", complete: false) == ["First."])
        #expect(accumulator.consume(itemID: "a", text: "First.\nSecond.", complete: true) == ["Second."])
        #expect(accumulator.consume(itemID: "a", text: "First.\nSecond.", complete: true).isEmpty)
        #expect(accumulator.consume(itemID: "a", text: "Changed.\n", complete: true).isEmpty)
        #expect(accumulator.consume(itemID: "b", text: "Another item.", complete: true) == ["Another item."])
    }
    @Test func boundedSpeechAndOrdinaryCode() {
        var accumulator = SpeechAccumulator()
        let text = "Explanation.\n```python\nprint('do not speak')\n```\n" + String(repeating: "word ", count: 2000)
        let spoken = accumulator.consume(itemID: "a", text: text, complete: true).joined()
        #expect(!spoken.contains("print"))
        #expect(accumulator.charactersSent == RealtimeVoiceProtocol.maxSpokenCharacters)
        #expect(spoken.count <= RealtimeVoiceProtocol.maxSpokenCharacters)
    }
    @Test func nestedMarkdownFencesNeverEscapeIntoSpeech() {
        let text = "Before.\n````markdown\n```clicky-visual\nsecret protocol\n```\n~~~\nstill code\n````\nAfter."
        for cut in 0...text.count {
            var accumulator = SpeechAccumulator()
            let chunks = accumulator.consume(itemID: "a", text: String(text.prefix(cut)), complete: false)
                + accumulator.consume(itemID: "a", text: text, complete: true)
            let spoken = chunks.joined(separator: " ")
            #expect(spoken.contains("Before.")); #expect(spoken.contains("After."))
            #expect(!spoken.contains("secret")); #expect(!spoken.contains("still code"))
        }
    }
    @Test func firstSentenceSpeaksBeforeTheParagraphCompletes() {
        var accumulator = SpeechAccumulator()
        #expect(accumulator.consume(itemID: "a", text: "First sentence. Sec", complete: false) == ["First sentence."])
        #expect(accumulator.consume(itemID: "a", text: "First sentence. Second sentence. Thi", complete: false) == ["Second sentence."])
        #expect(accumulator.consume(itemID: "a", text: "First sentence. Second sentence. Third sentence.", complete: true) == ["Third sentence."])
        #expect(accumulator.consume(itemID: "a", text: "First sentence. Second sentence. Third sentence.", complete: true).isEmpty)
    }
    @Test func sentenceBoundaryCannotComeFromAnOpenMarkerOrCode() {
        for text in ["[POINT:120,30. ", "[Link. ", "`inline code. ", "(unfinished aside. ", "```clicky-visual\n{\"op\":\"scene. "] {
            var accumulator = SpeechAccumulator()
            #expect(accumulator.consume(itemID: "a", text: text, complete: false).isEmpty)
        }
        var accumulator = SpeechAccumulator()
        #expect(accumulator.consume(itemID: "a", text: "Safe sentence. [POINT:120,30. ", complete: false) == ["Safe sentence."])
        #expect(accumulator.consume(itemID: "a", text: "Safe sentence. [POINT:120,300:Button] Next sentence. More", complete: false) == ["Next sentence."])
    }
    @Test func inlineBracketCodeNeverRetractsOrReplaysSpokenPrefix() {
        var accumulator = SpeechAccumulator()
        var chunks = accumulator.consume(itemID: "a", text: "Press Enter. Type `[` to o", complete: false)
        chunks += accumulator.consume(itemID: "a", text: "Press Enter. Type `[` to open. Then", complete: false)
        chunks += accumulator.consume(itemID: "a", text: "Press Enter. Type `[` to open. Then `]` closes. End", complete: false)
        #expect(chunks.filter { $0.contains("Press Enter.") }.count == 1)
        #expect(chunks.joined(separator: " ").contains("to open."))
    }
    @Test func abbreviationsAndListNumbersDoNotForceSpeechPauses() {
        for text in ["Use a tool, e.g. the", "Ask Dr. Smith", "Try this vs. that", "1. Begin"] {
            var accumulator = SpeechAccumulator()
            #expect(accumulator.consume(itemID: "a", text: text, complete: false).isEmpty)
        }
        var accumulator = SpeechAccumulator()
        #expect(accumulator.consume(itemID: "a", text: "Ask Dr. Smith. Then", complete: false) == ["Ask Dr. Smith."])
    }
    @Test func unfinishedInlineCodeCannotExposeAnUnfinishedPointMarker() {
        var accumulator = SpeechAccumulator()
        #expect(accumulator.consume(itemID: "a", text: "`[POINT:120,3. ", complete: true).isEmpty)
    }
    @Test func anUnclosedInlineSpanDoesNotMuteLaterLines() {
        for syntax in ["`npm test", "[unfinished link"] {
            var accumulator = SpeechAccumulator()
            #expect(accumulator.consume(itemID: "a", text: "Run the tests. Then check " + syntax, complete: false) == ["Run the tests."])
            let later = accumulator.consume(itemID: "a", text: "Run the tests. Then check " + syntax + "\nNext line here.\n", complete: false)
            #expect(later == ["Next line here."])
            #expect(accumulator.consume(itemID: "a", text: "Run the tests. Then check " + syntax + "\nNext line here.\n", complete: true).isEmpty)
        }
    }
    @Test func samplesSpanWebSocketFrames() {
        var decoder = PCM16Decoder()
        #expect(decoder.decode(Data([0xff])).isEmpty)
        #expect(decoder.decode(Data([0x7f, 0x00])) == [Float(32767) / 32768])
        #expect(decoder.decode(Data([0x80])) == [-1])
    }
    @Test func errorsAndFinalAudioDecode() throws {
        #expect(try RealtimeVoiceProtocol.decode(Data(#"{"audio":null,"isFinal":true}"#.utf8)) == .finished)
        #expect(try RealtimeVoiceProtocol.decode(Data(#"{"audio":"AQ==","isFinal":false}"#.utf8)) == .audio(Data([1]), final: false))
        #expect(throws: VoiceProtocolError.self) { try RealtimeVoiceProtocol.decode(Data(#"{"message_type":"auth_error"}"#.utf8)) }
        #expect(throws: VoiceProtocolError.self) { try RealtimeVoiceProtocol.decode(Data("not JSON".utf8)) }
    }
}
