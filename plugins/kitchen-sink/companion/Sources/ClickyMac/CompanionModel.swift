import AppKit
import ClickyCore
import Observation

struct TranscriptEntry: Codable, Identifiable {
    var id: String
    var role: String
    var text: String
    var turnID: String? = nil
}

extension RequestPhase {
    var label: String {
        switch self {
        case .ready: "Ready"
        case .sending: "Sending to BB…"
        case .running: "Working in BB…"
        case .needsApproval: "Needs your approval in BB"
        case .failed: "Stopped or failed in BB"
        case .deliveryUnknown: "Checking request delivery…"
        }
    }
}

struct InteractionRequest: Codable, Identifiable {
    var id = UUID().uuidString
    var title: String
    var remoteTitle: String
    var threadID: String?
    var hostID: String
    var serverURL: String = ""
    var sequence = 0
    var entries: [TranscriptEntry] = []
    var phase: RequestPhase = .ready
    var requestedAt = Date()
    var contextSummary: String? = nil
    var retired = false
    var lastRemoteUpdateAt: Double? = nil
    var lastEventReadAt: Date = .distantPast
    var submissionStarted = false
    var cancelRequested: Bool? = nil
    var stopAttempted: Bool? = nil
    var rootTurnID: String? = nil
    var sentAfterSequence: Int? = nil
    var completionStatus: String? = nil
    var visualRequest: VisualRequest? = nil
}

struct Preferences: Codable {
    var executable = BBConfiguration.defaultExecutablePath
    var runtimeExecutable: String? = BBConfiguration.defaultRuntimeExecutablePath
    var serverURL = ""
    var hostID = ""
    var elevenLabsVoiceID: String? = nil
    var includeInitialContext: Bool? = nil
}

struct SavedInteractions: Codable {
    var preferences: Preferences
    var requests: [InteractionRequest]
}

@Observable final class CompanionModel {
    var preferences = Preferences()
    var requests: [InteractionRequest] = []
    var outputRequestID: String?
    var hosts: [BBHost] = []
    var error: String?
    var connected = false
    var connecting = false
    var settingsVisible = false
    var panelVisible = false
    var recording = false
    var requestingMicrophone = false
    private struct VoiceRequestContext {
        let id = UUID()
        let connectionGeneration: UUID
        var releaseAllowed: Bool? = nil
    }
    private var voiceRequest: VoiceRequestContext?
    private var recordingStartedAt: Date?
    var visualDocument: VisualDocument?
    var visualWarning: String?
    var visualIsComplete = false
    var selectedVisualNodeID: String?
    var visualRevision = 0
    @ObservationIgnored var onVisualPresentation: (() -> Void)?
    @ObservationIgnored var onVisualDismiss: (() -> Void)?
    private var visualStreams: [String: VisualStream] = [:]
    private var assistantText: [String: [String: String]] = [:]
    private var dismissedVisualRequestIDs: Set<String> = []

    private var connectionGeneration = UUID()
    var transcribing = false
    var contextNotice: String?
    var accessibilityAllowed = false
    var screenCaptureAllowed = false
    @ObservationIgnored var contextCapture: ((CapturedScreen?) async -> InitialDesktopContext)?
    @ObservationIgnored var instructionsLoader: (() throws -> (String, String))?
    let desktop = DesktopServices()
    let voice = ElevenLabsVoice()
    var voiceKeyStatus = "Key not checked"
    private var speechOwner: (sessionID: String, requestID: String)?
    private var speechRaw: [String: String] = [:]
    private var speechOrder: [String] = []
    private var speechAccumulator = SpeechAccumulator()
    private var speechStarted = false
    private var speechFailed = false
    private var monitor: Task<Void, Never>?
    private var recordingLimit: Task<Void, Never>?
    private var turnCaptures: [String: CapturedScreen] = [:]
    private var guideReplies: [String: String] = [:]
    private var refreshing = false
    private var retryCount = 0
    private var nextRetryAt = Date.distantPast
    private var lastStatusRefreshAt = Date.distantPast
    private var lastSavedAt = Date.distantPast
    private let saveURL: URL
    private var client: BBClient { BBClient(configuration: BBConfiguration(executablePath: preferences.executable, serverURL: preferences.serverURL.isEmpty ? nil : preferences.serverURL, runtimeExecutablePath: preferences.runtimeExecutable)) }
    var serverRequests: [InteractionRequest] { requests.filter { $0.serverURL == preferences.serverURL } }
    var currentRequest: InteractionRequest? { serverRequests.first { $0.id == outputRequestID } }
    @ObservationIgnored var speechEnabled = true
    @ObservationIgnored var now: () -> Date = Date.init
    var pendingApprovals: [InteractionRequest] { serverRequests.filter { $0.phase == .needsApproval && !$0.retired } }
    var acceptingVoice: Bool { !recording && !requestingMicrophone && !transcribing }

    init(storageRoot: URL? = nil) {
        let root = storageRoot ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("ClickyBB")
        saveURL = root.appendingPathComponent("interactions.json")
        if let data = try? Data(contentsOf: saveURL), let saved = try? JSONDecoder().decode(SavedInteractions.self, from: data) {
            preferences = saved.preferences
            if preferences.executable.hasSuffix("/.bb/bin/bb"), BBConfiguration.defaultExecutablePath != preferences.executable {
                preferences.executable = BBConfiguration.defaultExecutablePath
                preferences.runtimeExecutable = BBConfiguration.defaultRuntimeExecutablePath
            }
            requests = saved.requests
            for i in requests.indices where requests[i].phase == .sending { requests[i].phase = requests[i].submissionStarted ? .deliveryUnknown : .failed }
            outputRequestID = requests.first?.id
            dismissedVisualRequestIDs = Set(requests.compactMap { $0.visualRequest?.id })
        }
        if !FileManager.default.fileExists(atPath: saveURL.path) {
            struct LegacySettings: Decodable { let preferences: Preferences }
            if let data = try? Data(contentsOf: root.appendingPathComponent("sessions.json")),
               let legacy = try? JSONDecoder().decode(LegacySettings.self, from: data) { preferences = legacy.preferences }
        }
        refreshContextPermissions()
        settingsVisible = false
        pruneRequests()
        voice.onInputFailure = { [weak self] message, partial in
            guard let self else { return }
            voiceRequest = nil; recording = false; requestingMicrophone = false; transcribing = false; recordingLimit?.cancel()
            error = message + " Hold the voice shortcut to ask again."
        }
        voice.onSpeechFailure = { [weak self] message in
            self?.speechFailed = true; self?.error = "Speech stopped. " + message
        }
    }

    func save() {
        lastSavedAt = Date()
        do {
            try FileManager.default.createDirectory(at: saveURL.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let data = try JSONEncoder().encode(SavedInteractions(preferences: preferences, requests: requests))
            try data.write(to: saveURL, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: saveURL.path)
        } catch { self.error = "Could not save request state: \(error.localizedDescription)" }
    }

    func connectionChanged() {
        cancelVoiceInput(); stopSpeaking()
        dismissVisuals()
        connectionGeneration = UUID()
        retryCount = 0
        connected = false
        hosts = []
        preferences.hostID = ""
    }

    func connect() async {
        guard !connecting else { return }
        guard !preferences.serverURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { error = "Enter an explicit BB server URL so requests stay tied to the right backend."; return }
        connecting = true
        let generation = connectionGeneration
        let transport = client
        defer { connecting = false }
        do {
            let fetched = try await transport.hosts()
            guard connectionGeneration == generation else { return }
            hosts = fetched
            connected = true
            retryCount = 0
            error = nil
            save()
            await refresh()
            startMonitoring()
        } catch { if connectionGeneration == generation { connectionFailed(error.localizedDescription) } }
    }

    /// Every question owns a fresh backend request. No previous thread or busy
    /// phase can gate a new ask; only output ownership moves to the latest ask.
    func ask(_ question: String) async {
        let text = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        stopSpeaking(); dismissVisuals()
        turnCaptures.removeAll(); guideReplies.removeAll()
        let id = UUID().uuidString
        let generation = connectionGeneration
        let transport = client
        let server = preferences.serverURL
        let host = preferences.hostID
        let requestedAt = now()
        let record = InteractionRequest(id: id, title: String(text.prefix(52)), remoteTitle: "Clicky request [\(id)]", hostID: host,
            serverURL: server, phase: .sending, requestedAt: requestedAt)
        requests.insert(record, at: 0); outputRequestID = id
        update(id) { $0.entries = [TranscriptEntry(id: "pending-\(id)", role: "user", text: text)] }
        error = nil; contextNotice = nil
        pruneRequests(); save()
        guard !host.isEmpty, !server.isEmpty else {
            update(id) { $0.phase = .failed }
            error = "BB is not configured. Set the server and machine in the menu's Settings."
            save(); return
        }
        var sentCapture: CapturedScreen?
        defer { if let sentCapture { desktop.discardCapture(sentCapture) } }
        var contextJSON: String?
        if preferences.includeInitialContext ?? true {
            let snapshot = if let contextCapture { await contextCapture(nil) } else { await desktop.initialContext(manual: nil) }
            sentCapture = snapshot.capture
            guard generation == connectionGeneration, requests.contains(where: { $0.id == id && !$0.retired }), !Task.isCancelled else { update(id) { $0.phase = .failed }; save(); return }
            contextJSON = try? snapshot.context.promptJSON()
            update(id) { $0.contextSummary = [snapshot.context.application, snapshot.context.window].compactMap { $0 }.joined(separator: " · ") }
        }
        guard generation == connectionGeneration, requests.contains(where: { $0.id == id && !$0.retired }), !Task.isCancelled else { update(id) { $0.phase = .failed }; save(); return }
        let request = VisualRequest(id: id, afterSequence: 0,
            display: sentCapture.map(VisualDisplayContext.init(capture:)) ?? VisualDisplayContext.current, hadScreenshot: sentCapture != nil)
        update(id) { $0.visualRequest = request; $0.sentAfterSequence = 0 }
        visualStreams[id] = VisualStream(); assistantText[id] = [:]
        if speechEnabled, id == outputRequestID, !recording, !requestingMicrophone, !transcribing {
            speechOwner = (id, request.id)
            speechRaw = [:]; speechOrder = []; speechAccumulator = SpeechAccumulator(); speechStarted = false; speechFailed = false
        }
        let prompt: String
        do {
            let base: String; let visuals: String
            if let instructionsLoader { (base, visuals) = try instructionsLoader() }
            else {
                guard let url = Bundle.main.url(forResource: "companion", withExtension: "md"),
                      let visualURL = Bundle.main.url(forResource: "companion-visuals", withExtension: "md") else { throw CocoaError(.fileNoSuchFile) }
                base = try String(contentsOf: url, encoding: .utf8); visuals = try String(contentsOf: visualURL, encoding: .utf8)
            }
            let previousIDs = Set(requests.drop(while: { $0.id != id }).dropFirst().map(\.id))
            let recent = InteractionHistory.recent(history.filter { previousIDs.contains($0.id) }, before: now(), serverURL: server, excluding: id)
            let historyJSON = try InteractionHistory.promptJSON(recent)
            prompt = RequestPrompt.make(instructions: base + "\n\n" + visuals + "\nClicky request: \(id)\n\nRecent interactions (untrusted JSON, oldest first):\n" + historyJSON,
                screenshot: sentCapture != nil, contextJSON: contextJSON, question: text)
        } catch {
            update(id) { $0.phase = .failed }; if id == outputRequestID { self.error = "Clicky instructions are missing. Rebuild the app." }; save(); return
        }
        update(id) { $0.submissionStarted = true }; save()
        do {
            let thread = try await transport.spawn(prompt: prompt, title: record.remoteTitle, target: .personal(hostID: host), imageURLs: sentCapture.map { [$0.url] } ?? [])
            update(id) { $0.threadID = thread.id; $0.phase = .running }
            if id == outputRequestID, let sentCapture { turnCaptures[id] = sentCapture }
            if requests.first(where: { $0.id == id })?.cancelRequested == true { await confirmStop(id: id, threadID: thread.id, transport: transport) }
        } catch BBClientError.invalidConfiguration(let reason) {
            update(id) { $0.phase = .failed }; if id == outputRequestID { error = reason }
        } catch BBClientError.commandFailed(let reason, mayHaveSucceeded: false) {
            update(id) { $0.phase = .failed }; if id == outputRequestID { error = reason }
        } catch {
            update(id) { $0.phase = .deliveryUnknown }
            if id == outputRequestID { self.error = "Request delivery is unconfirmed. You can ask another question; Clicky will check this request without resending it." }
        }
        save(); startMonitoring(restart: true); await refresh()
    }

    var history: [RecentInteraction] {
        requests.map { request in
            let question = request.entries.first(where: { $0.role == "user" })?.text ?? ""
            let reply = request.entries.filter { $0.role == "assistant" && $0.turnID == request.rootTurnID }.map(\.text).joined(separator: "\n")
            let outcome: String
            if !request.submissionStarted { outcome = "notSent" }
            else if request.retired && request.phase.busy { outcome = "unknown" }
            else {
                outcome = switch request.phase {
                case .ready: "completed"
                case .sending, .running: "pending"
                case .needsApproval: "needsApproval"
                case .failed: "failed"
                case .deliveryUnknown: "deliveryUnknown"
                }
            }
            return RecentInteraction(id: request.id, requestedAt: request.requestedAt, serverURL: request.serverURL, threadID: request.threadID,
                question: question, answer: reply, outcome: outcome, context: request.contextSummary)
        }
    }

    private func pruneRequests() {
        let time = now()
        for i in requests.indices {
            let age = time.timeIntervalSince(requests[i].requestedAt)
            if requests[i].phase == .deliveryUnknown && age > 120 || requests[i].phase.busy && age > 1800 { requests[i].retired = true }
        }
        let active = requests.filter { $0.phase.busy && !$0.retired }.map(\.id)
        for id in active.dropFirst(32) { update(id) { $0.retired = true } }
        let recentIDs = Set(requests.filter { time.timeIntervalSince($0.requestedAt) <= 600 }.prefix(6).map(\.id))
        requests.removeAll { $0.id != outputRequestID && (!$0.phase.busy || $0.retired) && !recentIDs.contains($0.id) }
        let retained = Set(requests.map(\.id))
        assistantText = assistantText.filter { retained.contains($0.key) }; visualStreams = visualStreams.filter { retained.contains($0.key) }
        turnCaptures = turnCaptures.filter { retained.contains($0.key) }; guideReplies = guideReplies.filter { retained.contains($0.key) }
    }

    func refresh(reconcileStatus: Bool = true) async {
        guard connected, !refreshing else { return }
        pruneRequests()
        refreshing = true
        defer { refreshing = false }
        let transport = client
        let generation = connectionGeneration
        let server = preferences.serverURL
        let statusDue = reconcileStatus || RequestPolling.statusDue(elapsed: Date().timeIntervalSince(lastStatusRefreshAt))
        do {
            let pending = requests.filter { $0.serverURL == server && $0.threadID == nil && $0.phase == .deliveryUnknown && !$0.retired }
            if statusDue, !pending.isEmpty {
                let candidates = try await transport.listThreads(projectID: "proj_personal")
                guard generation == connectionGeneration else { return }
                for session in pending {
                    let matches = candidates.filter { $0.title == session.remoteTitle }
                    if matches.count == 1, let match = matches.first {
                        update(session.id) { $0.threadID = match.id; $0.phase = .running }
                        if session.cancelRequested == true, session.stopAttempted != true { await confirmStop(id: session.id, threadID: match.id, transport: transport) }
                    }
                }
            }
            let fastID = fastSessionID
            let visible = requests.filter {
                $0.serverURL == server && $0.threadID != nil && (!$0.retired && ($0.phase.busy || $0.id == outputRequestID)) && (statusDue || $0.id == fastID)
            }.sorted { $0.id == fastID && $1.id != fastID }
            guard !visible.isEmpty else { if statusDue { lastStatusRefreshAt = Date() }; return }
            var statusRows: [BBThread]
            if statusDue {
                statusRows = try await transport.listThreads(ids: visible.compactMap(\.threadID))
                lastStatusRefreshAt = Date()
            } else { statusRows = [] }
            let background = visible.filter { $0.id != fastID }
            // Always read the output owner first; at most two background event
            // streams per status tick keep old jobs from starving live speech.
            let changed = background.filter { request in
                let remote = statusRows.first { $0.id == request.threadID }
                return remote?.updatedAt == nil || remote?.updatedAt != request.lastRemoteUpdateAt
            }.sorted { $0.lastEventReadAt < $1.lastEventReadAt }.prefix(2)
            var drainedIDs = Set<String>()
            for session in visible.filter({ $0.id == fastID }) + changed {
                guard let threadID = session.threadID else { continue }
                do {
                    try await readEvents(id: session.id, threadID: threadID, transport: transport)
                    drainedIDs.insert(session.id)
                    update(session.id) { $0.lastRemoteUpdateAt = statusRows.first(where: { $0.id == threadID })?.updatedAt; $0.lastEventReadAt = now() }
                } catch { if session.id == outputRequestID { self.error = "Could not refresh this request. " + error.localizedDescription } }
                guard generation == connectionGeneration else { return }
            }
            let becameTerminal = visible.contains { prior in
                prior.phase.busy && requests.first(where: { $0.id == prior.id })?.phase.busy == false
            }
            guard statusDue || RequestPolling.statusDue(elapsed: Date().timeIntervalSince(lastStatusRefreshAt), becameTerminal: becameTerminal) else {
                if Date().timeIntervalSince(lastSavedAt) >= RequestPolling.checkpointInterval,
                   visible.contains(where: { prior in requests.first(where: { $0.id == prior.id })?.sequence != prior.sequence }) { save() }
                return
            }
            if !statusDue {
                statusRows = try await transport.listThreads(ids: visible.compactMap(\.threadID))
            }
            // Read current state after the event page, so historical completion cannot override a newer active turn.
            let statuses = statusRows
            guard generation == connectionGeneration else { return }
            lastStatusRefreshAt = Date()
            for session in visible {
                if let remote = statuses.first(where: { $0.id == session.threadID }) {
                    // Idle is not a terminal result until this event stream
                    // has been drained. Skipped/failed reads stay pollable.
                    if remote.status == "idle", !drainedIDs.contains(session.id) { continue }
                    if remote.status == "idle", speechOwner?.sessionID == session.id,
                       requests.first(where: { $0.id == session.id })?.completionStatus == nil, let threadID = session.threadID {
                        // Completion can land between log and status reads. Consume
                        // its final text before treating idle as an interruption.
                        try await readEvents(id: session.id, threadID: threadID, transport: transport)
                        guard generation == connectionGeneration else { return }
                    }
                    update(session.id) {
                        $0.phase = $0.phase.reconciled(remoteStatus: remote.status, needsApproval: remote.hasPendingInteraction == true,
                            queued: remote.hasQueuedWork, observedRoot: $0.rootTurnID != nil, completionStatus: $0.completionStatus)
                    }
                } else {
                    update(session.id) { $0.phase = .failed }
                    error = "This request is no longer available in BB."
                }
                if speechOwner?.sessionID == session.id,
                   let phase = requests.first(where: { $0.id == session.id })?.phase, !phase.busy {
                    // Interruption can settle through thread status without a completion event.
                    stopSpeaking()
                }
            }
            save()
        } catch {
            guard generation == connectionGeneration else { return }
            connectionFailed("BB is unavailable. Your request is saved. \(error.localizedDescription)")
        }
    }

    private func readEvents(id: String, threadID: String, transport: BBClient) async throws {
        for _ in 0..<100 {
            guard let session = requests.first(where: { $0.id == id }) else { return }
            let events = try await transport.events(threadID: threadID, afterSequence: session.sequence)
            var groupedVisualDelta = ""
            for (offset, event) in events.enumerated() {
                update(id) { $0.sequence = max($0.sequence, event.seq) }
                switch event.kind {
                case let .turnStarted(isRoot):
                    if isRoot, let turnID = event.turnID {
                        let boundTurnID = requests.first(where: { $0.id == id })?.visualRequest?.turnID
                        if boundTurnID == nil || boundTurnID == turnID {
                            update(id) { $0.rootTurnID = turnID; $0.phase = .running }
                        }
                    }
                case let .turnInputAccepted(clientRequestID):
                    if let request = requests.first(where: { $0.id == id })?.visualRequest,
                       request.clientRequestID == clientRequestID, let turnID = event.turnID, event.seq > request.afterSequence {
                        update(id) { $0.visualRequest?.binding.observe(event); $0.rootTurnID = turnID; $0.phase = .running }
                    }
                case .threadInterrupted:
                    if speechOwner?.sessionID == id { stopSpeaking() }
                    update(id) { $0.phase = .failed; $0.completionStatus = "interrupted" }
                case let .userMessage(text):
                    update(id) { $0.visualRequest?.binding.observe(event) }
                    let visible = text.components(separatedBy: "\n\nUser request:\n").last ?? text
                    guard !visible.isEmpty else { continue }
                    update(id) { s in
                        if let i = s.entries.firstIndex(where: { $0.id.hasPrefix("pending-") && $0.text == visible }) {
                            s.entries[i].id = event.id; s.entries[i].turnID = event.turnID
                        } else if !s.entries.contains(where: { $0.id == event.id }) {
                            s.entries.append(TranscriptEntry(id: event.id, role: "user", text: visible, turnID: event.turnID))
                        }
                    }
                case let .assistantDelta(itemID, text):
                    guard let turnID = event.turnID, turnID == requests.first(where: { $0.id == id })?.rootTurnID else { continue }
                    feedSpeech(id: id, itemID: itemID, text: text, authoritative: false)
                    if requests.first(where: { $0.id == id })?.visualRequest?.turnID == turnID {
                        groupedVisualDelta += text
                        if offset + 1 < events.count, events[offset + 1].turnID == turnID,
                           case let .assistantDelta(nextItemID, _) = events[offset + 1].kind, nextItemID == itemID { continue }
                        let group = groupedVisualDelta; groupedVisualDelta = ""
                        if ingestVisual(id: id, event: event, itemID: itemID, text: group, authoritative: false) { continue }
                    }
                    recordAssistantText(id: id, event: event, itemID: itemID, text: text, authoritative: false)
                case let .assistantMessage(itemID, text):
                    guard let turnID = event.turnID, turnID == requests.first(where: { $0.id == id })?.rootTurnID else { continue }
                    feedSpeech(id: id, itemID: itemID, text: text, authoritative: true)
                    if ingestVisual(id: id, event: event, itemID: itemID, text: text, authoritative: true) { continue }
                    recordAssistantText(id: id, event: event, itemID: itemID, text: text, authoritative: true)
                case let .turnCompleted(status, message):
                    guard let current = requests.first(where: { $0.id == id }), let turnID = event.turnID, turnID == current.rootTurnID else { continue }
                    update(id) { $0.phase = status == "completed" ? .ready : .failed; $0.completionStatus = status }
                    if id == outputRequestID, let message, !message.isEmpty { error = message }
                    if let request = current.visualRequest, request.turnID == turnID {
                        finishVisual(id: id, successful: status == "completed")
                    }
                    if status == "completed", let baseline = current.sentAfterSequence, event.seq > baseline,
                       let reply = current.entries.last(where: { $0.role == "assistant" && $0.turnID == turnID })?.text {
                        if turnCaptures[id] != nil { guideReplies[id] = reply; if id == outputRequestID { showGuides() } }
                    }
                    if speechOwner?.sessionID == id {
                        finishSpeech(successful: status == "completed", summary: visualStreams[id]?.completedDocument?.summary)
                    }
                case .other: break
                }
            }
            if events.isEmpty { return }
        }
        throw BBClientError.responseTooLarge
    }

    func saveVoiceKey(_ key: String) {
        do { try VoiceKeychain.save(key); voiceKeyStatus = "Key saved in Keychain"; error = nil }
        catch { voiceKeyStatus = "Keychain access failed"; self.error = error.localizedDescription }
    }
    func checkVoiceKey() {
        do { voiceKeyStatus = try VoiceKeychain.read(allowInteraction: true) == nil ? "No key saved" : "Key available in Keychain" }
        catch { voiceKeyStatus = "Keychain access denied"; self.error = error.localizedDescription }
    }
    func removeVoiceKey() {
        cancelVoiceInput(); stopSpeaking()
        do { try VoiceKeychain.remove(); voiceKeyStatus = "No key saved" }
        catch { self.error = error.localizedDescription }
    }
    func stopSpeaking() {
        speechOwner = nil; speechRaw = [:]; speechOrder = []
        voice.stopSpeaking()
    }
    private func feedSpeech(id: String, itemID: String, text: String, authoritative: Bool) {
        guard !recording, !requestingMicrophone, !transcribing, let owner = speechOwner, owner.sessionID == id, id == outputRequestID,
              let current = currentRequest, owner.requestID == current.visualRequest?.id else { return }
        if speechRaw[itemID] == nil { speechOrder.append(itemID) }
        let raw = authoritative ? text : (speechRaw[itemID] ?? "") + text
        speechRaw[itemID] = raw
        for chunk in speechAccumulator.consume(itemID: itemID, text: raw, complete: authoritative) { speakChunk(chunk) }
    }
    private func speakChunk(_ text: String) {
        guard !recording, !requestingMicrophone, !transcribing, !speechFailed else { return }
        do {
            if !speechStarted {
                try voice.startSpeaking(voiceID: preferences.elevenLabsVoiceID ?? RealtimeVoiceProtocol.defaultVoiceID)
                speechStarted = true
            }
            voice.appendSpeech(text)
        } catch { speechFailed = true; self.error = "Could not speak the reply. " + error.localizedDescription }
    }
    private func finishSpeech(successful: Bool, summary: String?) {
        guard successful else { stopSpeaking(); return }
        for item in speechOrder {
            for chunk in speechAccumulator.consume(itemID: item, text: speechRaw[item] ?? "", complete: true) { speakChunk(chunk) }
        }
        if speechAccumulator.charactersSent == 0, let summary, !summary.isEmpty { speakChunk(String(summary.prefix(RealtimeVoiceProtocol.maxSpokenCharacters))) }
        if speechStarted, !speechFailed { voice.finishSpeech() }
        speechOwner = nil; speechRaw = [:]; speechOrder = []
    }
    private func cancelVoiceInput() {
        voiceRequest = nil; recording = false; requestingMicrophone = false; transcribing = false
        recordingLimit?.cancel(); voice.cancelInput()
    }

    private func update(_ id: String, _ mutation: (inout InteractionRequest) -> Void) {
        if let i = requests.firstIndex(where: { $0.id == id }) { mutation(&requests[i]) }
    }

    func dismissVisuals() {
        if let requestID = currentRequest?.visualRequest?.id { dismissedVisualRequestIDs.insert(requestID) }
        visualDocument = nil; selectedVisualNodeID = nil; visualWarning = nil; visualIsComplete = false
        desktop.clearPoints()
        onVisualDismiss?()
    }

    var visualDisplay: VisualDisplayContext? { currentRequest?.visualRequest?.display }
    private func recordAssistantText(id: String, event: BBEvent, itemID: String, text: String, authoritative: Bool) {
        let persisted = requests.first(where: { $0.id == id })?.entries.first(where: { $0.id == itemID })?.text ?? ""
        let raw = authoritative ? text : (assistantText[id]?[itemID] ?? persisted) + text
        assistantText[id, default: [:]][itemID] = raw
        let readable = VisualStream.visibleText(raw)
        update(id) { session in
            if let i = session.entries.firstIndex(where: { $0.id == itemID }) { session.entries[i].text = readable }
            else { session.entries.append(TranscriptEntry(id: itemID, role: "assistant", text: readable, turnID: event.turnID)) }
        }
    }

    private func ingestVisual(id: String, event: BBEvent, itemID: String, text: String, authoritative: Bool) -> Bool {
        guard let session = requests.first(where: { $0.id == id }), let request = session.visualRequest,
              request.binding.matches(event) else { return false }
        if !authoritative, visualStreams[id] == nil, session.entries.contains(where: { $0.id == itemID }) {
            // Raw protocol is not persisted. Keep the saved readable prefix until
            // the authoritative full item arrives instead of exposing an unframed tail.
            return true
        }
        var stream = visualStreams[id] ?? VisualStream()
        if authoritative { stream.replace(text: text, itemID: itemID) } else { stream.append(delta: text, itemID: itemID) }
        visualStreams[id] = stream
        let readable = stream.displayText(for: itemID)
        update(id) { s in
            if let i = s.entries.firstIndex(where: { $0.id == itemID }) { s.entries[i].text = readable }
            else { s.entries.append(TranscriptEntry(id: itemID, role: "assistant", text: readable, turnID: event.turnID)) }
        }
        guard id == outputRequestID, session.serverURL == preferences.serverURL,
              !dismissedVisualRequestIDs.contains(request.id) else { return true }
        let preview = stream.preview.flatMap { try? $0.validated() }
        if authoritative, preview == nil { clearReplacedVisual() }
        visualWarning = stream.warning
        if let document = preview, visualDocument != document {
            guard document.kind != .overlay || (request.hadScreenshot && request.display?.matchingScreen != nil) else {
                visualWarning = "Screen marks need a capture from the current display."
                return true
            }
            visualDocument = document; visualRevision += 1
            if !document.nodes.contains(where: { $0.id == selectedVisualNodeID }) { selectedVisualNodeID = nil }
            onVisualPresentation?()
        }
        return true
    }

    /// An authoritative response can retract its streamed graphics without
    /// dismissing the request: a later message may still supply a new visual.
    private func clearReplacedVisual() {
        let wasPresented = visualDocument != nil
        visualDocument = nil; selectedVisualNodeID = nil; visualWarning = nil; visualIsComplete = false
        if wasPresented { onVisualDismiss?() }
    }

    private func finishVisual(id: String, successful: Bool) {
        guard let session = requests.first(where: { $0.id == id }), let request = session.visualRequest,
              let stream = visualStreams[id] else { return }
        let isSelected = id == outputRequestID && session.serverURL == preferences.serverURL
        let isPresented = isSelected && !dismissedVisualRequestIDs.contains(request.id) && visualDocument != nil
        guard stream.hasVisualContent else {
            // Plain text is a complete answer. An optional visual is not a missing result.
            if isSelected { clearReplacedVisual() }
            return
        }
        if successful, let document = stream.completedDocument,
           document.kind != .overlay || (request.hadScreenshot && request.display?.matchingScreen != nil) {
            if !document.summary.isEmpty, requests.first(where: { $0.id == id })?.entries.contains(where: { $0.role == "assistant" && !$0.text.isEmpty }) != true {
                update(id) { $0.entries.append(TranscriptEntry(id: "summary-" + id, role: "assistant", text: document.summary, turnID: $0.rootTurnID)) }
            }
            if isPresented { visualIsComplete = true }
        } else if isPresented {
            visualIsComplete = false
            visualWarning = successful ? (stream.warning ?? "BB did not finish a valid visual. Ask a follow-up or open the request in BB.") : "Generation stopped. This is an unfinished preview."
        }
    }

    func showGuides() {
        guard let id = outputRequestID, let request = currentRequest?.visualRequest,
              !dismissedVisualRequestIDs.contains(request.id), let screen = turnCaptures[id], let reply = guideReplies[id] else { return }
        desktop.showPoints(in: reply, for: screen)
    }
    var hasGuides: Bool {
        guard let id = outputRequestID, turnCaptures[id] != nil, let reply = guideReplies[id] else { return false }
        return !ScreenPoint.parse(in: reply).points.isEmpty
    }

    func stop() async {
        cancelVoiceInput(); stopSpeaking(); desktop.clearPoints()
        guard let s = currentRequest else { return }
        guard s.phase.busy else { return }
        update(s.id) { $0.cancelRequested = true; $0.stopAttempted = false }
        guard let threadID = s.threadID else {
            if !s.submissionStarted { update(s.id) { $0.retired = true; $0.phase = .failed } }
            save(); return
        }
        await confirmStop(id: s.id, threadID: threadID, transport: client)
    }

    private func confirmStop(id: String, threadID: String, transport: BBClient) async {
        guard requests.first(where: { $0.id == id })?.stopAttempted != true else { return }
        update(id) { $0.stopAttempted = true }; save()
        do { try await transport.stop(threadID: threadID); update(id) { $0.phase = .failed; $0.retired = true }; save() }
        catch { if id == outputRequestID { self.error = "Could not confirm stop. This request is still tracked in BB. \(error.localizedDescription)" } }
    }

    func openInBB(requestID: String? = nil) async {
        guard let request = requests.first(where: { $0.id == (requestID ?? outputRequestID) }), request.serverURL == preferences.serverURL, let id = request.threadID else { return }
        do { try await client.open(threadID: id) } catch { self.error = error.localizedDescription }
    }

    func refreshContextPermissions() {
        accessibilityAllowed = desktop.accessibilityAllowed
        screenCaptureAllowed = desktop.screenCaptureAllowed
    }
    func requestAccessibility() { desktop.requestAccessibility(); refreshContextPermissions() }
    func requestScreenCapture() { desktop.requestScreenCapture(); refreshContextPermissions() }
    func beginRecording() async {
        // A new hold always silences the previous answer, including a running BB turn.
        stopSpeaking()
        guard acceptingVoice else { return }
        let request = VoiceRequestContext(connectionGeneration: connectionGeneration)
        voiceRequest = request; requestingMicrophone = true; error = nil
        if !connected { await connect() }
        guard connected, voiceRequest?.id == request.id else { cancelVoiceInput(); return }
        recordingStartedAt = Date()
        recordingLimit = Task {
            try? await Task.sleep(for: .seconds(30))
            guard !Task.isCancelled else { return }
            recordingLimit = nil
            await endRecording()
        }
        defer { if voiceRequest?.id == request.id { requestingMicrophone = false } }
        do {
            try await voice.startListening()
            guard voiceRequest?.id == request.id else { return }
            recording = true; requestingMicrophone = false
            if voiceRequest?.releaseAllowed == true { await endRecording() }
        } catch is CancellationError { }
        catch {
            if voiceRequest?.id == request.id { cancelVoiceInput(); self.error = error.localizedDescription }
        }
    }

    func endRecording() async {
        if requestingMicrophone {
            // A quick question can finish before the WebSocket handshake. Stop
            // capture now, then drain its buffered audio after session_started.
            if voice.hasLiveCapture { voiceRequest?.releaseAllowed = true; voice.releaseCapture() }
            else { cancelVoiceInput(); error = "Voice is not ready yet. Hold to ask again after macOS finishes authorization." }
            return
        }
        guard recording, let request = voiceRequest else { return }
        let duration = recordingStartedAt.map { Date().timeIntervalSince($0) } ?? 0
        recordingStartedAt = nil
        recording = false; recordingLimit?.cancel()
        if duration < 0.3 { cancelVoiceInput(); return }
        transcribing = true
        defer { if voiceRequest?.id == request.id { voiceRequest = nil; transcribing = false } }
        do {
            let text = try await voice.finishListening()
            guard voiceRequest?.id == request.id, request.connectionGeneration == connectionGeneration else { return }
            guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw VoiceProtocolError.noSpeech }
            transcribing = false
            voiceRequest = nil
            await ask(text)
        } catch is CancellationError { }
        catch { if voiceRequest?.id == request.id { self.error = error.localizedDescription } }
    }
    private func connectionFailed(_ message: String) {
        connected = false; error = message
        retryCount += 1
        nextRetryAt = Date().addingTimeInterval(min(30, pow(2, Double(retryCount))))
        startMonitoring()
    }
    private var fastSessionID: String? {
        serverRequests.first(where: {
            !$0.retired && RequestPolling.isFast(phase: $0.phase, foreground: $0.id == outputRequestID || $0.id == speechOwner?.sessionID, isJob: false)
        })?.id
    }
    func startMonitoring(restart: Bool = false) {
        if restart { monitor?.cancel(); monitor = nil }
        guard monitor == nil else { return }
        monitor = Task { [weak self] in
            while !Task.isCancelled {
                let interval = self?.fastSessionID != nil ? RequestPolling.fastInterval : RequestPolling.statusInterval
                try? await Task.sleep(for: .seconds(interval))
                guard !Task.isCancelled, let self else { return }
                let stillBusy = self.serverRequests.contains(where: { $0.phase.busy && !$0.retired })
                if self.connected && stillBusy {
                    await self.refresh(reconcileStatus: false)
                } else if !self.connected && self.retryCount > 0 && self.retryCount <= 3 && Date() >= self.nextRetryAt && (self.panelVisible || stillBusy) { await self.connect() }
            }
        }
    }
    func shutdown() { cancelVoiceInput(); stopSpeaking(); voice.shutdown(); onVisualDismiss?(); monitor?.cancel(); recordingLimit?.cancel(); desktop.shutdown(); save() }
}
