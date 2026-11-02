import Foundation
import Testing
import Darwin
@testable import ClickyCore

private struct FakeCLI {
    let directory: URL
    let executable: URL

    init(body: String) throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("clicky-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        executable = directory.appendingPathComponent("bb fixture")
        let script = """
        #!/usr/bin/python3
        import json, os, sys, time
        from pathlib import Path
        directory = Path(__file__).parent
        args = sys.argv[1:]
        \(body)
        """
        try Data(script.utf8).write(to: executable)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
    }

    func client(timeout: Double = 5) -> BBClient {
        BBClient(configuration: BBConfiguration(executablePath: executable.path, timeoutSeconds: timeout))
    }

    func remove() { try? FileManager.default.removeItem(at: directory) }
}

@Test func spawnPassesLiteralPromptAndSelectedHost() async throws {
    let cli = try FakeCLI(body: """
    prompt_path = args[args.index('--prompt-file') + 1]
    capture = {'args': args, 'prompt': Path(prompt_path).read_text(), 'promptPath': prompt_path,
               'contextKeys': [key for key in ('BB_CLI','BB_CLI_REEXEC','BB_THREAD_ID','BB_PROJECT_ID','BB_ENVIRONMENT_ID') if key in os.environ]}
    (directory / 'capture.json').write_text(json.dumps(capture))
    print(json.dumps({'id':'thr_new','projectId':'proj_personal','environmentId':'env_personal','title':'Clicky [token]', 'titleFallback':None,'status':'starting'}))
    """)
    defer { cli.remove() }
    let prompt = "Keep `backticks`, $(command), quotes \" and\nnewlines literal."
    let thread = try await cli.client().spawn(prompt: prompt, title: "Clicky [token]", target: .personal(hostID: "host_mac"))
    #expect(thread.id == "thr_new")
    struct Capture: Decodable { let args: [String]; let prompt: String; let promptPath: String; let contextKeys: [String] }
    let capture = try JSONDecoder().decode(Capture.self, from: Data(contentsOf: cli.directory.appendingPathComponent("capture.json")))
    #expect(capture.prompt == prompt)
    #expect(capture.args.contains("host_mac"))
    #expect(capture.args.contains("personal"))
    #expect(capture.args.contains("accept-edits"))
    #expect(!capture.args.contains(prompt))
    #expect(!capture.args.contains("--parent-self"))
    #expect(capture.contextKeys.isEmpty)
    #expect(!FileManager.default.fileExists(atPath: capture.promptPath))
}

@Test func environmentSpawnDoesNotAlsoSelectMachine() async throws {
    let cli = try FakeCLI(body: """
    assert '--machine' not in args
    assert args[args.index('--environment')+1] == 'env_selected'
    assert args[args.index('--project')+1] == 'proj_selected'
    print(json.dumps({'id':'thr_new','projectId':'proj_selected','environmentId':'env_selected','title':None,'titleFallback':None,'status':'starting'}))
    """)
    defer { cli.remove() }
    let thread = try await cli.client().spawn(prompt: "hello", title: "Clicky", target: .environment(projectID: "proj_selected", environmentID: "env_selected"))
    #expect(thread.environmentId == "env_selected")
}

@Test func voiceUsesMP4MimeType() async throws {
    let cli = try FakeCLI(body: """
    assert args[:2] == ['voice','transcribe']
    assert args[args.index('--type')+1] == 'audio/mp4'
    print(json.dumps({'text':'A transcribed question'}))
    """)
    defer { cli.remove() }
    let text = try await cli.client().transcribe(audioURL: cli.directory.appendingPathComponent("voice.m4a"))
    #expect(text == "A transcribed question")
}

@Test func queuedSendIsNotReportedAsCompleted() async throws {
    let cli = try FakeCLI(body: """
    assert args[args.index('--mode')+1] == 'steer'
    print(json.dumps({'ok':True,'threadId':'thr_a','delivery':'queued','queuedMessage':{'waitingOn':{'kind':'interaction'}}}))
    """)
    defer { cli.remove() }
    let receipt = try await cli.client().tell(threadID: "thr_a", prompt: "follow up")
    #expect(receipt.ok)
    #expect(receipt.delivery == "queued")
}

@Test func nonzeroExitUsesStructuredError() async throws {
    let cli = try FakeCLI(body: """
    print(json.dumps({'ok':False,'error':{'code':'offline','message':'Host is disconnected'}}))
    print('extra CLI detail', file=sys.stderr)
    sys.exit(1)
    """)
    defer { cli.remove() }
    do {
        _ = try await cli.client().hosts()
        Issue.record("Expected a disconnected error")
    } catch BBClientError.commandFailed(let message, let uncertain) {
        #expect(message == "Host is disconnected")
        #expect(!uncertain)
    }
}

@Test func largeStderrCannotBlockSubprocess() async throws {
    let cli = try FakeCLI(body: """
    sys.stderr.write('diagnostic ' * 30000)
    print(json.dumps([{'id':'host_1','name':'Mac','status':'connected'}]))
    """)
    defer { cli.remove() }
    let hosts = try await cli.client().hosts()
    #expect(hosts.first?.name == "Mac")
}

@Test func timeoutReportsUncertainWrite() async throws {
    let cli = try FakeCLI(body: """
    (directory / 'pid').write_text(str(os.getpid()))
    time.sleep(30)
    """)
    defer { cli.remove() }
    do {
        _ = try await cli.client(timeout: 0.3).spawn(prompt: "request", title: "Clicky [reconcile]", target: .personal(hostID: "host_a"))
        Issue.record("Expected timeout")
    } catch BBClientError.timedOut(let uncertain) {
        #expect(uncertain)
    }

}

@Test func cancellationKillsProcess() async throws {
    let cli = try FakeCLI(body: """
    (directory / 'pid').write_text(str(os.getpid()))
    time.sleep(30)
    """)
    defer { cli.remove() }
    let client = cli.client()
    let task = Task { try await client.hosts() }
    let pidFile = cli.directory.appendingPathComponent("pid")
    for _ in 0..<100 {
        if FileManager.default.fileExists(atPath: pidFile.path) { break }
        try await Task.sleep(for: .milliseconds(20))
    }
    let pid = try #require(Int32(String(contentsOf: pidFile, encoding: .utf8)))
    task.cancel()
    do {
        _ = try await task.value
        Issue.record("Expected cancellation")
    } catch is CancellationError {}
    for _ in 0..<20 {
        if Darwin.kill(pid, 0) != 0 { break }
        try await Task.sleep(for: .milliseconds(20))
    }
    #expect(Darwin.kill(pid, 0) != 0)
}

@Test func eventsKeepCursorAndSeparateRepliesFromToolOutput() throws {
    let json = #"""
    [
      {"id":"e1","seq":1,"scope":{"kind":"turn","turnId":"turn1"},"type":"client/turn/requested","data":{"input":[{"type":"text","text":"Question"}]}},
      {"id":"e2","seq":2,"scope":{"kind":"turn","turnId":"turn1"},"type":"item/agentMessage/delta","data":{"itemId":"m1","delta":"Hello"}},
      {"id":"e3","seq":3,"type":"item/completed","data":{"item":{"id":"tool1","type":"commandExecution","aggregatedOutput":"Do not display"}}},
      {"id":"e4","seq":4,"type":"item/completed","data":{"item":{"id":"m1","type":"agentMessage","text":"Hello there"}}},
      {"id":"e5","seq":5,"type":"item/completed","data":{"item":{"id":"child1","type":"agentMessage","text":"Child output","parentToolCallId":"child-tool"}}},
      {"id":"e6","seq":6,"type":"turn/completed","data":{"status":"failed","error":{"message":"Connection lost"}}},
      {"id":"e7","seq":7,"type":"future/event","data":null}
    ]
    """#
    let events = try JSONDecoder().decode([BBEvent].self, from: Data(json.utf8))
    #expect(events.count == 7)
    #expect(events[0].kind == .userMessage("Question"))
    #expect(events[0].turnID == "turn1")
    #expect(events[1].kind == .assistantDelta(itemID: "m1", text: "Hello"))
    #expect(events[2].kind == .other)
    #expect(events[3].kind == .assistantMessage(itemID: "m1", text: "Hello there"))
    #expect(events[4].kind == .other)
    #expect(events[5].kind == .turnCompleted(status: "failed", error: "Connection lost"))
    #expect(events.last?.seq == 7)
}

@Test func threadRuntimeCarriesWaitingAndApprovalState() throws {
    let json = #"{"id":"thr_1","projectId":"proj_personal","status":"active","runtime":{"displayStatus":"waiting-for-host"},"hasPendingInteraction":true,"queuedWork":"waiting"}"#
    let thread = try JSONDecoder().decode(BBThread.self, from: Data(json.utf8))
    #expect(thread.displayStatus == "waiting-for-host")
    #expect(thread.hasPendingInteraction == true)
    #expect(thread.queuedWork == "waiting")
}

@Test func explicitRuntimeReceivesCLIPathAndLiteralArguments() async throws {
    let runtime = try FakeCLI(body: """
    assert args[0].endswith('raw bb command')
    assert args[1:] == ['machine', 'list', '--json']
    assert os.environ.get('ELECTRON_RUN_AS_NODE') == '1'
    assert os.environ.get('BB_SERVER_URL') == 'http://127.0.0.1:54321'
    print(json.dumps([{'id':'host_runtime','name':'Mac','status':'connected'}]))
    """)
    defer { runtime.remove() }
    let rawCLI = runtime.directory.appendingPathComponent("raw bb command")
    try Data("// The runtime loads this file".utf8).write(to: rawCLI)
    let configuration = BBConfiguration(executablePath: rawCLI.path, serverURL: "http://127.0.0.1:54321", runtimeExecutablePath: runtime.executable.path)
    let hosts = try await BBClient(configuration: configuration).hosts()
    #expect(hosts.first?.id == "host_runtime")
    #expect(BBConfiguration(executablePath: runtime.executable.path).runtimeExecutablePath == nil)
}

@Test func turnLifecyclePreservesRootAndChildIdentity() throws {
    let json = #"""
    [
      {"id":"rootStart","seq":1,"scope":{"kind":"turn","turnId":"root"},"type":"turn/started","data":{}},
      {"id":"childStart","seq":2,"scope":{"kind":"turn","turnId":"child"},"type":"turn/started","data":{"parentToolCallId":"tool"}},
      {"id":"childEnd","seq":3,"scope":{"kind":"turn","turnId":"child"},"type":"turn/completed","data":{"status":"completed"}},
      {"id":"stop","seq":4,"scope":{"kind":"thread"},"type":"system/thread/interrupted","data":{"reason":"host-daemon-restarted","cause":"host-connection-lost"}},
      {"id":"unknownItem","seq":5,"scope":{"kind":"turn","turnId":"root"},"type":"item/completed","data":{"item":{"type":"newTool","unexpected":"shape"}}},
      {"id":"malformedTool","seq":6,"type":"item/completed","data":{"item":null}}
    ]
    """#
    let events = try JSONDecoder().decode([BBEvent].self, from: Data(json.utf8))
    #expect(events[0].kind == .turnStarted(isRoot: true))
    #expect(events[0].turnID == "root")
    #expect(events[1].kind == .turnStarted(isRoot: false))
    #expect(events[2].turnID == "child")
    #expect(events[2].kind == .turnCompleted(status: "completed", error: nil))
    #expect(events[3].kind == .threadInterrupted(reason: "host-daemon-restarted", cause: "host-connection-lost"))
    #expect(events[3].turnID == nil)
    #expect(events[4].kind == .other)
    #expect(events[5].kind == .other)
    #expect(events.last?.seq == 6)
}

@Test(arguments: ["invalid_request", "unauthorized", "thread_not_found", "http_403"])
func definitiveRejectionDoesNotLeaveDeliveryUncertain(code: String) async throws {
    let cli = try FakeCLI(body: """
    print(json.dumps({'ok':False,'error':{'code':'\(code)','message':'Request rejected'}}))
    sys.exit(1)
    """)
    defer { cli.remove() }
    do {
        _ = try await cli.client().spawn(prompt: "request", title: "Clicky", target: .personal(hostID: "host_a"))
        Issue.record("Expected rejection")
    } catch BBClientError.commandFailed(let reason, let uncertain) {
        #expect(reason == "Request rejected")
        #expect(!uncertain)
    }
}

@Test(arguments: ["connection_failed", "http_500", "error"])
func networkAndGenericWriteFailuresRemainUncertain(code: String) async throws {
    let cli = try FakeCLI(body: """
    print(json.dumps({'ok':False,'error':{'code':'\(code)','message':'Connection ended'}}))
    sys.exit(1)
    """)
    defer { cli.remove() }
    do {
        _ = try await cli.client().tell(threadID: "thr_a", prompt: "request")
        Issue.record("Expected failure")
    } catch BBClientError.commandFailed(_, let uncertain) {
        #expect(uncertain)
    }
}

@Test(arguments: ["server", "local"])
func oversizedEventPagesShrinkWithoutSkippingSequence(source: String) async throws {
    let cli = try FakeCLI(body: """
    limit = int(args[args.index('--limit')+1])
    assert args[args.index('--after-seq')+1] == '42'
    with (directory / 'limits').open('a') as f:
        f.write(str(limit) + '\\n')
    if limit > 50:
        if '\(source)' == 'server':
            print(json.dumps({'ok':False,'error':{'code':'event_data_too_large','message':'Too many events'}}))
            sys.exit(1)
        else:
            sys.stdout.write('x' * (8 * 1024 * 1024 + 1))
            sys.exit(0)
    print(json.dumps([{'id':'event43','seq':43,'type':'future/event','data':None}]))
    """)
    defer { cli.remove() }
    let events = try await cli.client().events(threadID: "thr_a", afterSequence: 42)
    #expect(events.map(\.seq) == [43])
    let requestedLimits = try String(contentsOf: cli.directory.appendingPathComponent("limits"), encoding: .utf8)
    #expect(requestedLimits == "200\n100\n50\n")
}

@Test(arguments: [("none", false), ("waiting", true), ("failed", true)])
func threadQueuedWorkUsesQueueStateInsteadOfFieldPresence(state: String, expected: Bool) throws {
    let json = """
    {"id":"thr_idle","projectId":"proj_personal","status":"idle","queuedWork":"\(state)"}
    """
    let thread = try JSONDecoder().decode(BBThread.self, from: Data(json.utf8))
    #expect(thread.hasQueuedWork == expected)
}

@Test func threadWithoutQueueMetadataHasNoQueuedWork() throws {
    let json = #"{"id":"thr_old","projectId":"proj_personal","status":"idle"}"#
    let thread = try JSONDecoder().decode(BBThread.self, from: Data(json.utf8))
    #expect(!thread.hasQueuedWork)
}

@Test func requestAcceptanceCorrelatesTheSubmittedMessageToItsActualTurn() throws {
    let json = #"""
    [
      {"id":"request","seq":101,"scope":{"kind":"thread"},"type":"client/turn/requested","data":{"direction":"outbound","requestId":"req_clicky","source":"tell","initiator":"user","senderThreadId":null,"input":[{"type":"text","text":"Visual request nonce: clicky-42\nExplain this screen"}],"target":{"kind":"new-turn"},"request":{"method":"turn/start","params":{}},"execution":{}}},
      {"id":"unrelatedStart","seq":102,"scope":{"kind":"turn","turnId":"turn_other"},"type":"turn/started","data":{"providerThreadId":"provider"}},
      {"id":"unrelatedAcceptance","seq":103,"scope":{"kind":"turn","turnId":"turn_other"},"type":"turn/input/accepted","data":{"providerThreadId":"provider","clientRequestId":"req_other"}},
      {"id":"actualAcceptance","seq":104,"scope":{"kind":"turn","turnId":"turn_actual"},"type":"turn/input/accepted","data":{"providerThreadId":"provider","clientRequestId":"req_clicky"}}
    ]
    """#
    let events = try JSONDecoder().decode([BBEvent].self, from: Data(json.utf8))
    #expect(events[0].kind == .userMessage("Visual request nonce: clicky-42\nExplain this screen"))
    #expect(events[0].clientRequestID == "req_clicky")
    #expect(events[0].turnID == nil)
    #expect(events[1].kind == .turnStarted(isRoot: true))
    #expect(events[1].clientRequestID == nil)
    #expect(events[2].kind == .turnInputAccepted(clientRequestID: "req_other"))
    #expect(events[3].kind == .turnInputAccepted(clientRequestID: "req_clicky"))
    #expect(events[3].turnID == "turn_actual")
    #expect(events[3].clientRequestID == nil)
}

@Test func requestWithoutCorrelationIDDoesNotInventOne() throws {
    let json = #"{"id":"legacy","seq":12,"scope":{"kind":"thread"},"type":"client/turn/requested","data":{"input":[{"type":"text","text":"Older request"}]}}"#
    let event = try JSONDecoder().decode(BBEvent.self, from: Data(json.utf8))
    #expect(event.kind == .userMessage("Older request"))
    #expect(event.clientRequestID == nil)
}

@Test func inputAcceptanceRequiresItsServerRequestID() {
    let json = #"{"id":"invalidAcceptance","seq":13,"scope":{"kind":"turn","turnId":"turn_x"},"type":"turn/input/accepted","data":{"requestId":"wrong-field"}}"#
    #expect(throws: DecodingError.self) {
        _ = try JSONDecoder().decode(BBEvent.self, from: Data(json.utf8))
    }
}
