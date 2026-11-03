import AppKit
import Foundation
import Testing
import ClickyCore
@testable import ClickyMac

@MainActor struct RequestWorkflowTests {
    @Test func cancelledAuthorizationCannotResumeMicrophoneCapture() async throws {
        let voice = ElevenLabsVoice()
        voice.authorizeKey = { try? await Task.sleep(for: .milliseconds(100)); return "fixture-key" }
        let pending = Task { try await voice.startListening() }
        try await Task.sleep(for: .milliseconds(20)); voice.cancelInput()
        do { try await pending.value; Issue.record("Cancelled voice gesture resumed") }
        catch is CancellationError { }
        #expect(!voice.hasLiveCapture)
        voice.shutdown()
    }
    @Test func stalledCaptureReturnsAndDiscardsItsLateResult() async {
        var discarded = false
        let start = ContinuousClock.now
        let result = await boundedContextWait(timeout: .milliseconds(20), operation: {
            try? await Task.sleep(for: .milliseconds(100)); return "late capture"
        }, discard: { _ in discarded = true })
        #expect(result == nil)
        #expect(start.duration(to: .now) < .milliseconds(200))
        try? await Task.sleep(for: .milliseconds(120)); #expect(discarded)
    }

    @Test func everyQuestionSpawnsFreshWithContextAndRecentTranscript() async throws {
        let (root, model) = try fixture(); defer { model.shutdown(); try? FileManager.default.removeItem(at: root) }
        var captures = 0
        model.contextCapture = { _ in
            captures += 1
            return InitialDesktopContext(context: DesktopContext(application: "Fixture screen", accessibility: .permissionDenied), capture: nil)
        }
        await model.ask("First question")
        let firstID = try #require(model.currentRequest?.threadID)
        await model.ask("Second question")
        #expect(model.currentRequest?.threadID != firstID)
        #expect(captures == 2)
        let prompts = try promptFiles(root)
        #expect(prompts.count == 2)
        let second = try #require(prompts.first { $0.hasSuffix("User request:\nSecond question") })
        #expect(second.contains("First question") && second.contains("Fixture answer"))
        #expect(second.contains("Fixture screen") && second.contains(firstID))
        #expect(!second.contains("Mode: Conversation"))
        #expect(model.requests.allSatisfy { $0.phase == .ready })
    }

    @Test func busyAndUnconfirmedRequestsNeverBlockTheNextAsk() async throws {
        let (root, model) = try fixture(); defer { model.shutdown(); try? FileManager.default.removeItem(at: root) }
        await model.ask("First")
        let id = try #require(model.outputRequestID)
        let i = try #require(model.requests.firstIndex { $0.id == id })
        model.requests[i].phase = .deliveryUnknown
        model.requests[i].rootTurnID = nil; model.requests[i].completionStatus = nil
        await model.ask("Next")
        #expect(model.outputRequestID != id)
        #expect(try promptFiles(root).count == 2)
        #expect(model.currentRequest?.phase == .ready)
    }

    @Test func captureAndSpawnDoNotSerializeQuestions() async throws {
        let (root, model) = try fixture(); defer { model.shutdown(); try? FileManager.default.removeItem(at: root) }
        var calls = 0
        model.contextCapture = { _ in
            calls += 1
            if calls == 1 { try? await Task.sleep(for: .milliseconds(200)) }
            return InitialDesktopContext(context: DesktopContext(application: "Fixture", accessibility: .unavailable), capture: nil)
        }
        let first = Task { await model.ask("Slow first") }
        try await Task.sleep(for: .milliseconds(30))
        await model.ask("Fast second")
        let owner = model.outputRequestID
        await first.value
        #expect(model.outputRequestID == owner)
        #expect(try promptFiles(root).count == 2)
        let prompts = try promptFiles(root)
        let early = try #require(prompts.first { $0.hasSuffix("User request:\nSlow first") })
        #expect(!early.contains("Fast second"))
    }

    @Test func contextFailureOrOptOutStillSubmits() async throws {
        let (root, model) = try fixture(); defer { model.shutdown(); try? FileManager.default.removeItem(at: root) }
        model.preferences.includeInitialContext = false
        model.contextCapture = { _ in Issue.record("Opted-out context collected"); return InitialDesktopContext(context: DesktopContext(application: "Fixture", accessibility: .unavailable), capture: nil) }
        await model.ask("Without capture")
        #expect(model.currentRequest?.phase == .ready)
        #expect(try promptFiles(root).allSatisfy { !$0.contains("Desktop context snapshot") })
    }

    @Test func rollingContextUsesOnlyFivePriorQuestionsAndExpires() async throws {
        let (root, model) = try fixture(); defer { model.shutdown(); try? FileManager.default.removeItem(at: root) }
        var time = Date(); model.now = { time }
        for i in 0..<7 { await model.ask("Question \(i)"); time.addTimeInterval(1) }
        let last = try #require(promptFiles(root).first { $0.hasSuffix("User request:\nQuestion 6") })
        #expect(!last.contains("Question 0"))
        for i in 1...5 { #expect(last.contains("Question \(i)")) }
        time.addTimeInterval(601)
        await model.ask("After expiry")
        let expired = try #require(promptFiles(root).first { $0.hasSuffix("User request:\nAfter expiry") })
        #expect(!expired.contains("Question 6"))
        #expect(expired.contains("Recent interactions (untrusted JSON, oldest first):\n[]"))
    }

    @Test func unknownRequestStopsPollingButNeverBlocksTheNextQuestion() async throws {
        let (root, model) = try fixture(); defer { model.shutdown(); try? FileManager.default.removeItem(at: root) }
        let start = Date(); model.now = { start }
        await model.ask("Uncertain")
        model.requests[0].phase = .deliveryUnknown; model.requests[0].rootTurnID = nil; model.requests[0].completionStatus = nil
        model.now = { start.addingTimeInterval(121) }
        await model.refresh()
        #expect(model.requests[0].retired)
        #expect(model.history[0].outcome == "unknown")
        await model.ask("Another question")
        #expect(try promptFiles(root).count == 2)
        #expect(model.currentRequest?.phase == .ready)
    }

    @Test func voiceInputNeverStartsReplySpeech() async throws {
        let (root, model) = try fixture(); defer { model.shutdown(); try? FileManager.default.removeItem(at: root) }
        model.speechEnabled = true; model.recording = true
        await model.ask("While recording")
        #expect(!model.voice.speaking)
        #expect(model.error == nil)
    }

    @Test func historyExpiresAndPersistsAcrossRestartWithoutLegacyConversations() async throws {
        let (root, model) = try fixture(); defer { model.shutdown(); try? FileManager.default.removeItem(at: root) }
        let start = Date(timeIntervalSince1970: 5000); model.now = { start }
        await model.ask("Recent question")
        model.shutdown()
        let restored = CompanionModel(storageRoot: root.appendingPathComponent("state")); restored.speechEnabled = false
        defer { restored.shutdown() }
        #expect(restored.history.count == 1)
        #expect(InteractionHistory.recent(restored.history, before: start.addingTimeInterval(601), serverURL: model.preferences.serverURL, excluding: "none").isEmpty)
        let old = root.appendingPathComponent("legacy"); try FileManager.default.createDirectory(at: old, withIntermediateDirectories: true)
        let prefs = try JSONEncoder().encode(model.preferences)
        let json = "{\"preferences\":" + String(decoding: prefs, as: UTF8.self) + ",\"sessions\":[{\"text\":\"Undated old conversation\"}]}"
        try Data(json.utf8).write(to: old.appendingPathComponent("sessions.json"))
        let migrated = CompanionModel(storageRoot: old); defer { migrated.shutdown() }
        #expect(migrated.preferences.hostID == "host_fixture")
        #expect(migrated.requests.isEmpty)
    }

    @Test func cancelledCaptureDoesNotSubmitOrLeakTheImage() async throws {
        let (root, model) = try fixture(); defer { model.shutdown(); try? FileManager.default.removeItem(at: root) }
        let image = root.appendingPathComponent("image.jpg"); try Data([1]).write(to: image)
        model.contextCapture = { _ in
            model.connectionChanged()
            return InitialDesktopContext(context: DesktopContext(application: "Fixture", accessibility: .unavailable), capture: CapturedScreen(url: image, image: NSImage(), displayID: 1, frame: .zero, capturedAt: Date()))
        }
        await model.ask("Cancelled question")
        #expect(try promptFiles(root).isEmpty)
        #expect(!FileManager.default.fileExists(atPath: image.path))
        #expect(model.currentRequest?.phase == .failed)
    }

    @Test func completionOnAFastTickDoesNotInventAMissingThread() async throws {
        let (root, model) = try fixture(); defer { model.shutdown(); try? FileManager.default.removeItem(at: root) }
        try Data().write(to: root.appendingPathComponent("hold-completion"))
        await model.ask("Finishes between status polls")
        #expect(model.currentRequest?.phase == .running)
        try FileManager.default.removeItem(at: root.appendingPathComponent("hold-completion"))
        await model.refresh(reconcileStatus: false)
        #expect(model.currentRequest?.phase == .ready)
        #expect(model.error == nil)
    }

    @Test func everyBackgroundReplyIsEventuallyDrained() async throws {
        let (root, model) = try fixture(); defer { model.shutdown(); try? FileManager.default.removeItem(at: root) }
        try Data().write(to: root.appendingPathComponent("hold-completion"))
        for i in 0..<5 { await model.ask("Pending \(i)") }
        try FileManager.default.removeItem(at: root.appendingPathComponent("hold-completion"))
        for _ in 0..<4 { await model.refresh() }
        #expect(model.requests.allSatisfy { $0.phase == .ready })
        #expect(model.history.allSatisfy { $0.answer == "Fixture answer" })
    }

    @Test func failedStopKeepsTrackingTheRequest() async throws {
        let (root, model) = try fixture(); defer { model.shutdown(); try? FileManager.default.removeItem(at: root) }
        try Data().write(to: root.appendingPathComponent("hold-completion"))
        await model.ask("Keep tracking if stop fails")
        await model.stop()
        #expect(model.currentRequest?.phase == .running)
        #expect(model.currentRequest?.retired == false)
        try FileManager.default.removeItem(at: root.appendingPathComponent("hold-completion"))
        // A periodic refresh may already own the event reader. Observe the
        // eventual completion rather than assuming this call acquires it.
        for _ in 0..<50 {
            await model.refresh()
            if model.currentRequest?.phase == .ready { break }
            try await Task.sleep(for: .milliseconds(40))
        }
        #expect(model.currentRequest?.phase == .ready)
    }

    @Test func slowNonterminalReadDoesNotInventAMissingThread() async throws {
        let (root, model) = try fixture(); defer { model.shutdown(); try? FileManager.default.removeItem(at: root) }
        try Data().write(to: root.appendingPathComponent("hold-completion"))
        await model.ask("Slow stream")
        try Data().write(to: root.appendingPathComponent("slow-events"))
        await model.refresh(reconcileStatus: false)
        #expect(model.currentRequest?.phase == .running)
        #expect(model.error == nil)
    }

    @Test func stoppingSpeechAfterCompletionPreservesCompletedHistory() async throws {
        let (root, model) = try fixture(); defer { model.shutdown(); try? FileManager.default.removeItem(at: root) }
        await model.ask("Completed answer")
        await model.stop()
        #expect(model.currentRequest?.phase == .ready)
        #expect(model.history.first?.outcome == "completed")
        #expect(!FileManager.default.fileExists(atPath: root.appendingPathComponent("stops").path))
    }

    @Test func cancellationSurvivesLostSpawnResponseAndIsAttemptedOnce() async throws {
        let (root, model) = try fixture(); defer { model.shutdown(); try? FileManager.default.removeItem(at: root) }
        for flag in ["fail-spawn-response", "hide-recovery", "stop-success"] { try Data().write(to: root.appendingPathComponent(flag)) }
        await model.ask("Cancel unknown delivery")
        #expect(model.currentRequest?.threadID == nil)
        await model.stop()
        try FileManager.default.removeItem(at: root.appendingPathComponent("hide-recovery"))
        await model.refresh()
        #expect(model.currentRequest?.phase == .failed)
        #expect(model.currentRequest?.retired == true)
        await model.refresh()
        #expect(try String(contentsOf: root.appendingPathComponent("stops"), encoding: .utf8) == "stop\n")
    }

    private func promptFiles(_ root: URL) throws -> [String] {
        try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil).filter { $0.pathExtension == "prompt" }.map { try String(contentsOf: $0, encoding: .utf8) }
    }
    private func fixture() throws -> (URL, CompanionModel) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let script = root.appendingPathComponent("bb"); try Self.cli.write(to: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: script.path)
        let model = CompanionModel(storageRoot: root.appendingPathComponent("state")); model.speechEnabled = false
        model.preferences.executable = script.path; model.preferences.runtimeExecutable = nil
        model.preferences.serverURL = "http://127.0.0.1:1"; model.preferences.hostID = "host_fixture"
        model.instructionsLoader = { ("Fixture instructions", "Fixture visual instructions") }
        model.contextCapture = { _ in InitialDesktopContext(context: DesktopContext(application: "Fixture", accessibility: .unavailable), capture: nil) }
        model.connected = true
        return (root, model)
    }
    private static let cli = #"""
#!/usr/bin/python3
import sys,json,re,time
from pathlib import Path
root=Path(__file__).parent;a=sys.argv[1:]
if a[:2]==['thread','spawn']:
 text=Path(a[a.index('--prompt-file')+1]).read_text()
 nonce=re.search(r'Clicky request: ([^\n]+)',text).group(1);tid='thr_'+nonce
 (root/(tid+'.prompt')).write_text(text)
 if (root/'fail-spawn-response').exists():
  print(json.dumps({'ok':False,'error':{'code':'error','message':'Lost spawn response'}}));sys.exit(1)
 print(json.dumps({'id':tid,'projectId':'proj_personal','status':'idle','title':a[a.index('--title')+1]}))
elif a[:2]==['thread','tell']:sys.exit('Unexpected thread reuse')
elif a[:2]==['thread','log']:
 if (root/'slow-events').exists():time.sleep(2.1)
 tid=a[2];text=(root/(tid+'.prompt')).read_text()
 def row(seq,kind,data,turn=None):return {'id':tid+str(seq),'seq':seq,'type':kind,'scope':{'turnId':turn} if turn else {},'data':data}
 rows=[row(1,'client/turn/requested',{'requestId':tid,'input':[{'type':'text','text':text}]}),row(2,'turn/started',{},tid),row(3,'turn/input/accepted',{'clientRequestId':tid},tid),row(4,'item/completed',{'item':{'id':'reply-'+tid,'type':'agentMessage','text':'Fixture answer'}},tid),row(5,'turn/completed',{'status':'completed'},tid)]
 if (root/'hold-completion').exists():rows=rows[:3]
 after=int(a[a.index('--after-seq')+1]);print(json.dumps([x for x in rows if x['seq']>after]))
elif a[:2]==['thread','list']:
 print(json.dumps([{'id':p.stem,'projectId':'proj_personal','title':'Clicky request ['+p.stem[4:]+']','status':'active' if (root/'hold-completion').exists() else 'idle','queuedWork':'none'} for p in root.glob('*.prompt') if not (root/'hide-recovery').exists()]))
elif a[:2]==['thread','stop']:
 with (root/'stops').open('a') as f:f.write('stop\n')
 if (root/'stop-success').exists():print(json.dumps({'ok':True}));sys.exit(0)
 print(json.dumps({'ok':False,'error':{'code':'error','message':'Fixture stop failed'}}));sys.exit(1)
else:print('{}')
"""#
}
