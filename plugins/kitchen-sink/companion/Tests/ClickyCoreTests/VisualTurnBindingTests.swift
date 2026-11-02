import Foundation
import Testing
@testable import ClickyCore

@Suite struct VisualTurnBindingTests {
    private let nonce = "request-123"

    @Test func oldSequenceAndUnrelatedStartsCannotBind() throws {
        var binding = VisualTurnBinding(nonce: nonce, afterSequence: 10)
        binding.observe(try requested(seq: 10, request: "old", text: "Clicky request: \(nonce)"))
        binding.observe(try event(seq: 11, type: "turn/started", turn: "unrelated", data: [:]))
        #expect(binding.clientRequestID == nil)
        #expect(binding.turnID == nil)
        #expect(!binding.matches(try delta(seq: 12, turn: "unrelated")))
    }

    @Test func exactMarkerAndAcceptedInputBindARootWithoutAStartEvent() throws {
        var binding = VisualTurnBinding(nonce: nonce, afterSequence: 10)
        binding.observe(try requested(seq: 11, request: "correct", text: "Instructions\nClicky request: \(nonce)\nUser request:\nDraw it"))
        binding.observe(try accepted(seq: 12, request: "other", turn: "unrelated"))
        #expect(binding.turnID == nil)
        binding.observe(try accepted(seq: 13, request: "correct", turn: "already-running-root"))
        #expect(binding.clientRequestID == "correct")
        #expect(binding.turnID == "already-running-root")
        #expect(binding.matches(try delta(seq: 14, turn: "already-running-root")))
        #expect(!binding.matches(try delta(seq: 10, turn: "already-running-root")))
        #expect(!binding.matches(try delta(seq: 14, turn: "child-turn")))
        #expect(!binding.matches(try delta(seq: 14, turn: nil)))
    }

    @Test func missingTurnAndAcceptanceBeforeRequestCannotBind() throws {
        var binding = VisualTurnBinding(nonce: nonce, afterSequence: 0)
        binding.observe(try accepted(seq: 1, request: "correct", turn: "too-early"))
        #expect(binding.turnID == nil)
        binding.observe(try requested(seq: 2, request: "correct", text: "Clicky request: \(nonce)"))
        binding.observe(try accepted(seq: 3, request: "correct", turn: nil))
        #expect(binding.turnID == nil)
        #expect(!binding.matches(try delta(seq: 4, turn: nil)))
    }

    @Test func markersRequireAnExactLine() throws {
        for text in ["Clicky request: \(nonce)-suffix", "prefix Clicky request: \(nonce)", " Clicky request: \(nonce)", "Clicky request: \(nonce) ", "Clicky request: different"] {
            var binding = VisualTurnBinding(nonce: nonce, afterSequence: 0)
            binding.observe(try requested(seq: 1, request: "wrong", text: text))
            #expect(binding.clientRequestID == nil)
        }
        var binding = VisualTurnBinding(nonce: nonce, afterSequence: 0)
        binding.observe(try requested(seq: 1, request: "correct", text: "Before\r\nClicky request: \(nonce)\r\nAfter"))
        #expect(binding.clientRequestID == "correct")
    }

    @Test func laterRequestsCannotStealAnExistingBinding() throws {
        var binding = VisualTurnBinding(nonce: nonce, afterSequence: 0)
        binding.observe(try requested(seq: 1, request: "first", text: "Clicky request: \(nonce)"))
        binding.observe(try requested(seq: 2, request: "second", text: "Clicky request: \(nonce)"))
        binding.observe(try accepted(seq: 3, request: "second", turn: "wrong"))
        #expect(binding.clientRequestID == "first")
        #expect(binding.turnID == nil)
        binding.observe(try accepted(seq: 4, request: "first", turn: "root"))
        binding.observe(try requested(seq: 5, request: "other", text: "Another request"))
        binding.observe(try accepted(seq: 6, request: "other", turn: "other-root"))
        #expect(binding.turnID == "root")
    }

    @Test func assistantOutputCannotSupplyRequestOwnership() throws {
        var binding = VisualTurnBinding(nonce: nonce, afterSequence: 0)
        binding.observe(try event(seq: 1, type: "item/agentMessage/delta", turn: "wrong", data: ["itemId": "item", "delta": "Clicky request: \(nonce)", "requestId": "forged"]))
        binding.observe(try accepted(seq: 2, request: "forged", turn: "wrong"))
        #expect(binding.clientRequestID == nil)
        #expect(binding.turnID == nil)
    }

    @Test func persistenceRetainsAuthoritativeOwnership() throws {
        var binding = VisualTurnBinding(nonce: nonce, afterSequence: 5)
        binding.observe(try requested(seq: 6, request: "r", text: "Clicky request: \(nonce)"))
        binding.observe(try accepted(seq: 7, request: "r", turn: "root"))
        let decoded = try JSONDecoder().decode(VisualTurnBinding.self, from: JSONEncoder().encode(binding))
        #expect(decoded == binding)
        #expect(decoded.matches(try delta(seq: 8, turn: "root")))
    }

    private func requested(seq: Int, request: String, text: String) throws -> BBEvent {
        try event(seq: seq, type: "client/turn/requested", turn: nil, data: ["requestId": request, "input": [["type": "text", "text": text]]])
    }
    private func accepted(seq: Int, request: String, turn: String?) throws -> BBEvent {
        try event(seq: seq, type: "turn/input/accepted", turn: turn, data: ["clientRequestId": request])
    }
    private func delta(seq: Int, turn: String?) throws -> BBEvent {
        try event(seq: seq, type: "item/agentMessage/delta", turn: turn, data: ["itemId": "item", "delta": "text"])
    }
    private func event(seq: Int, type: String, turn: String?, data: [String: Any]) throws -> BBEvent {
        var value: [String: Any] = ["id": "event-\(seq)", "seq": seq, "type": type, "data": data]
        if let turn { value["scope"] = ["turnId": turn] }
        return try JSONDecoder().decode(BBEvent.self, from: JSONSerialization.data(withJSONObject: value))
    }
}
