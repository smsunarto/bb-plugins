import AppKit
import Foundation
import Testing
import ClickyCore
@testable import ClickyMac

@MainActor struct InitialContextTests {
    @Test func stalledCaptureReturnsAndDiscardsItsLateResult() async {
        var discarded = false
        let start = ContinuousClock.now
        let result = await boundedContextWait(timeout: .milliseconds(20), operation: {
            // Deliberately ignore cancellation, like a stalled platform API.
            try? await Task.sleep(for: .milliseconds(100))
            return "late capture"
        }, discard: { _ in discarded = true })
        #expect(result == nil)
        #expect(start.duration(to: .now) < .milliseconds(200))
        try? await Task.sleep(for: .milliseconds(120))
        #expect(discarded)
    }

    @Test func initialPayloadIsAttachedAndNeverStoredInLocalChatText() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let script = root.appendingPathComponent("bb")
        try Self.cli.write(to: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: script.path)
        let model = CompanionModel(storageRoot: root.appendingPathComponent("state"))
        model.preferences.executable = script.path; model.preferences.runtimeExecutable = nil
        model.preferences.serverURL = "http://127.0.0.1:1"; model.preferences.hostID = "host_fixture"
        model.instructionsLoader = { ("Fixture instructions", "Fixture visual instructions") }
        var captures = 0
        let image = root.appendingPathComponent("screen.jpg"); try Data([1]).write(to: image)
        model.contextCapture = { manual in
            captures += 1
            var context = DesktopContext(application: "ContextFixture", accessibility: .available)
            context.window = "Private context label"
            let captured = manual ?? CapturedScreen(url: image, image: NSImage(size: CGSize(width: 2, height: 2)), displayID: 1, frame: CGRect(x: 0, y: 0, width: 100, height: 100), capturedAt: Date())
            return InitialDesktopContext(context: context, capture: captured)
        }
        model.connected = true; model.draft = "Question one"
        await model.send()
        #expect(captures == 1)
        let first = try String(contentsOf: root.appendingPathComponent("prompt"), encoding: .utf8)
        #expect(first.contains("Private context label"))
        #expect(first.contains("Screen attached to this message: yes"))
        #expect(model.selected?.visualRequest?.hadScreenshot == true)
        #expect(!FileManager.default.fileExists(atPath: image.path))
        #expect(!model.selected!.entries.contains { $0.text.contains("Private context label") })
        #expect(model.selected?.phase == .ready)
        model.draft = "Question two"; await model.send()
        #expect(captures == 1)
        let followup = try String(contentsOf: root.appendingPathComponent("prompt"), encoding: .utf8)
        #expect(!followup.contains("Desktop context snapshot"))
        #expect(model.selected?.phase == .ready)
        model.shutdown()
    }

    @Test(arguments: ["disabled", "skip"]) func optedOutContextDoesNotCollect(mode: String) async throws {
        let (root, model) = try Self.fixture()
        defer { model.shutdown(); try? FileManager.default.removeItem(at: root) }
        model.preferences.includeInitialContext = mode != "disabled"; model.skipInitialContext = mode == "skip"
        var collected = false
        model.contextCapture = { _ in collected = true; return InitialDesktopContext(context: DesktopContext(application: "Fixture", accessibility: .available), capture: nil) }
        await model.send()
        #expect(!collected)
        let prompt = try String(contentsOf: root.appendingPathComponent("prompt"), encoding: .utf8)
        #expect(!prompt.contains("Desktop context snapshot"))
        #expect(model.selected?.phase == .ready)
    }

    @Test func missingPermissionsStillSendsTheQuestion() async throws {
        let (root, model) = try Self.fixture()
        defer { model.shutdown(); try? FileManager.default.removeItem(at: root) }
        model.contextCapture = { _ in
            var context = DesktopContext(application: "Fixture", accessibility: .permissionDenied)
            context.screenshot = .permissionDenied
            return InitialDesktopContext(context: context, capture: nil)
        }
        await model.send()
        let prompt = try String(contentsOf: root.appendingPathComponent("prompt"), encoding: .utf8)
        #expect(prompt.contains("permissionDenied"))
        #expect(prompt.hasSuffix("User request:\nFixture question"))
        #expect(model.selected?.phase == .ready)
        #expect(model.contextNotice?.contains("permission is needed") == true)
    }

    @Test func manualImageIsTheSingleAttachmentAndIsCleanedAfterRejection() async throws {
        let (root, model) = try Self.fixture()
        defer { model.shutdown(); try? FileManager.default.removeItem(at: root) }
        let image = root.appendingPathComponent("manual.jpg"); try Data([1]).write(to: image)
        model.capture = CapturedScreen(url: image, image: NSImage(), displayID: 1, frame: .zero, capturedAt: Date())
        model.contextCapture = { manual in
            #expect(manual?.url == image)
            return InitialDesktopContext(context: DesktopContext(application: "Fixture", accessibility: .unavailable), capture: manual)
        }
        try Data().write(to: root.appendingPathComponent("reject"))
        await model.send()
        let args = try JSONDecoder().decode([String].self, from: Data(contentsOf: root.appendingPathComponent("args")))
        #expect(args.filter { $0 == image.path }.count == 1)
        #expect(!FileManager.default.fileExists(atPath: image.path))
        #expect(model.draft == "Fixture question")
        #expect(model.selected?.phase == .failed)
        #expect(model.contextNotice?.contains("was not sent") == true)
        #expect(model.contextNotice?.contains("saved in the BB thread") == false)
    }

    @Test func changingConnectionDuringCaptureDoesNotSpawn() async throws {
        let (root, model) = try Self.fixture()
        defer { model.shutdown(); try? FileManager.default.removeItem(at: root) }
        model.contextCapture = { _ in
            model.connectionChanged()
            return InitialDesktopContext(context: DesktopContext(application: "Fixture", accessibility: .unavailable), capture: nil)
        }
        await model.send()
        #expect(!FileManager.default.fileExists(atPath: root.appendingPathComponent("prompt").path))
        #expect(model.selected?.threadID == nil)
        #expect(model.selected?.phase == .ready)
        #expect(model.draft == "Fixture question")
    }

    @Test func returningToTheSameConversationCannotReviveASupersededSend() async throws {
        let (root, model) = try Self.fixture()
        defer { model.shutdown(); try? FileManager.default.removeItem(at: root) }
        let original = try #require(model.selectedID)
        model.contextCapture = { _ in
            model.newConversation()
            model.select(original)
            model.draft = "Replacement draft"
            return InitialDesktopContext(context: DesktopContext(application: "Fixture", accessibility: .unavailable), capture: nil)
        }
        await model.send()
        #expect(!FileManager.default.fileExists(atPath: root.appendingPathComponent("prompt").path))
        #expect(model.selected?.threadID == nil)
        #expect(model.selected?.entries.isEmpty == true)
        #expect(model.draft == "Replacement draft")
    }

    @Test func switchingConversationsDuringCaptureCannotSendOrKeepAnAutoImage() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let model = CompanionModel(storageRoot: root)
        model.preferences.hostID = "host_fixture"; model.connected = true
        let image = root.appendingPathComponent("screen.jpg"); try Data([1]).write(to: image)
        model.contextCapture = { _ in
            try? await Task.sleep(for: .milliseconds(100))
            return InitialDesktopContext(context: DesktopContext(application: "Fixture", accessibility: .permissionDenied), capture: CapturedScreen(url: image, image: NSImage(), displayID: 1, frame: .zero, capturedAt: Date()))
        }
        model.draft = "Old conversation"
        let pending = Task { await model.send() }
        try await Task.sleep(for: .milliseconds(20)); model.newConversation(); model.draft = "New draft"
        await pending.value
        #expect(model.draft == "New draft")
        #expect(model.selected?.threadID == nil)
        #expect(model.selected?.entries.isEmpty == true)
        #expect(!FileManager.default.fileExists(atPath: image.path))
        model.shutdown()
    }

    private static func fixture() throws -> (URL, CompanionModel) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let script = root.appendingPathComponent("bb")
        try cli.write(to: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: script.path)
        let model = CompanionModel(storageRoot: root.appendingPathComponent("state"))
        model.preferences.executable = script.path; model.preferences.runtimeExecutable = nil
        model.preferences.serverURL = "http://127.0.0.1:1"; model.preferences.hostID = "host_fixture"
        model.instructionsLoader = { ("Fixture instructions", "Fixture visual instructions") }
        model.newConversation(); model.connected = true; model.draft = "Fixture question"
        return (root, model)
    }

    private static let cli = #"""
#!/usr/bin/python3
import sys,json,re
from pathlib import Path
root=Path(__file__).parent;a=sys.argv[1:]
if a[:2] in (['thread','spawn'],['thread','tell']):
 flag='--prompt-file' if a[1]=='spawn' else '--message-file'
 text=Path(a[a.index(flag)+1]).read_text();(root/'prompt').write_text(text)
 (root/'args').write_text(json.dumps(a))
 if (root/'reject').exists():
  print(json.dumps({'ok':False,'error':{'code':'unauthorized','message':'Fixture rejection'}}));sys.exit(1)
 turn=int((root/'turn').read_text())+1 if (root/'turn').exists() else 1
 (root/'turn').write_text(str(turn))
 print(json.dumps({'id':'thr_fixture','threadId':'thr_fixture','ok':True,'projectId':'proj_personal','status':'idle'}))
elif a[:2]==['thread','log']:
 text=(root/'prompt').read_text();base=(int((root/'turn').read_text())-1)*4
 def row(seq,kind,data,turn=None):return {'id':str(seq),'seq':seq,'type':kind,'scope':{'turnId':turn} if turn else {},'data':data}
 rows=[row(base+1,'client/turn/requested',{'requestId':str(base),'input':[{'type':'text','text':text}]}),row(base+2,'turn/started',{},str(base)),row(base+3,'turn/input/accepted',{'clientRequestId':str(base)},str(base)),row(base+4,'turn/completed',{'status':'completed'},str(base))]
 after=int(a[a.index('--after-seq')+1]);print(json.dumps([x for x in rows if x['seq']>after]))
elif a[:2]==['thread','list']:print(json.dumps([{'id':'thr_fixture','projectId':'proj_personal','status':'idle','queuedWork':'none'}]))
else:print('{}')
"""#
}
