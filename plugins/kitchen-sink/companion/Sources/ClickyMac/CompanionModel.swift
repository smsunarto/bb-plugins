import AppKit
import ClickyCore
import Observation

struct ChatEntry: Codable, Identifiable {
    var id: String
    var role: String
    var text: String
    var turnID: String? = nil
}

extension ConversationPhase {
    var label: String {
        switch self {
        case .ready: "Ready"
        case .sending: "Sending to BB…"
        case .running: "Working in BB…"
        case .needsApproval: "Needs your approval in BB"
        case .failed: "Stopped or failed in BB"
        case .deliveryUnknown: "Delivery unconfirmed. Refresh before sending again."
        }
    }
}

struct Conversation: Codable, Identifiable {
    var id = UUID().uuidString
    var title: String
    var remoteTitle: String
    var threadID: String?
    var hostID: String
    var serverURL: String = ""
    var sequence = 0
    var entries: [ChatEntry] = []
    var phase: ConversationPhase = .ready
    var isJob = false
    var rootTurnID: String? = nil
    var sentAfterSequence: Int? = nil
    var completionStatus: String? = nil
    var visualRequest: VisualRequest? = nil
    var speakReplyForCurrentTurn: Bool? = nil
}

struct Preferences: Codable {
    var executable = BBConfiguration.defaultExecutablePath
    var runtimeExecutable: String? = BBConfiguration.defaultRuntimeExecutablePath
    var serverURL = ""
    var hostID = ""
    var speakReplies = false
    var elevenLabsVoiceID: String? = nil
    var includeInitialContext: Bool? = nil
}

struct SavedCompanion: Codable {
    var preferences: Preferences
    var sessions: [Conversation]
}

@Observable final class CompanionModel {
    var preferences = Preferences()
    var sessions: [Conversation] = []
    var selectedID: String?
    var draft = ""
    var hosts: [BBHost] = []
    var error: String?
    var connected = false
    var connecting = false
    var settingsVisible = false
    var panelVisible = true
    var recording = false
    var requestingMicrophone = false
    private struct VoiceRequestContext {
        let id = UUID()
        let autoSend: Bool
        let sessionID: String?
        let connectionGeneration: UUID
        var releaseAllowed: Bool? = nil
    }
    private var voiceRequest: VoiceRequestContext?
    private var recordingStartedAt: Date?
    var sending = false
    var visualDocument: VisualDocument?
    var visualWarning: String?
    var visualIsComplete = false
    var selectedVisualNodeID: String?
    var visualRevision = 0
    @ObservationIgnored var onVisualPresentation: (() -> Void)?
    @ObservationIgnored var onVisualDismiss: (() -> Void)?
    private var visualStreams: [String: VisualStream] = [:]
    private var assistantText: [String: [String: String]] = [:]
    private let visualStore = VisualSnapshotStore()
    private var dismissedVisualRequestIDs: Set<String> = []
    private var reopenableVisual: VisualDocument?

    private var connectionGeneration = UUID()
    private var selectionGeneration = UUID()
    var transcribing = false
    var capture: CapturedScreen?
    var capturing = false
    var skipInitialContext = false
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
    var visibleSessions: [Conversation] { sessions.filter { $0.serverURL == preferences.serverURL } }
    var selected: Conversation? { visibleSessions.first { $0.id == selectedID } }
    var canSend: Bool { connected && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !(selected?.phase.busy ?? false) && !recording && !requestingMicrophone && !transcribing && !capturing }

    init(storageRoot: URL? = nil) {
        let root = storageRoot ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("ClickyBB")
        saveURL = root.appendingPathComponent("sessions.json")
        if let data = try? Data(contentsOf: saveURL), let saved = try? JSONDecoder().decode(SavedCompanion.self, from: data) {
            preferences = saved.preferences
            if preferences.executable.hasSuffix("/.bb/bin/bb"), BBConfiguration.defaultExecutablePath != preferences.executable {
                preferences.executable = BBConfiguration.defaultExecutablePath
                preferences.runtimeExecutable = BBConfiguration.defaultRuntimeExecutablePath
            }
            sessions = saved.sessions
            for i in sessions.indices where sessions[i].phase == .sending { sessions[i].phase = .deliveryUnknown }
            selectedID = sessions.first?.id
            dismissedVisualRequestIDs = Set(sessions.compactMap { $0.visualRequest?.id })
        }
        refreshContextPermissions()
        settingsVisible = preferences.hostID.isEmpty
        if sessions.isEmpty { newConversation() }
        loadSavedVisualForSelection()
        voice.onInputFailure = { [weak self] message, partial in
            guard let self else { return }
            if let request = voiceRequest, request.sessionID == selectedID, request.connectionGeneration == connectionGeneration, !partial.isEmpty {
                draft = draft.isEmpty ? partial : draft + "\n\n" + partial
            }
            voiceRequest = nil; recording = false; requestingMicrophone = false; transcribing = false; recordingLimit?.cancel()
            error = message + (partial.isEmpty ? "" : " The partial transcript is in your draft; review it before sending.")
        }
        voice.onSpeechFailure = { [weak self] message in
            self?.speechFailed = true; self?.error = "Speech stopped. " + message
        }
    }

    func save() {
        lastSavedAt = Date()
        do {
            try FileManager.default.createDirectory(at: saveURL.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let data = try JSONEncoder().encode(SavedCompanion(preferences: preferences, sessions: sessions))
            try data.write(to: saveURL, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: saveURL.path)
        } catch { self.error = "Could not save conversation state: \(error.localizedDescription)" }
    }

    func connectionChanged() {
        cancelVoiceInput(); stopSpeaking()
        dismissVisuals()
        reopenableVisual = nil
        connectionGeneration = UUID()
        retryCount = 0
        connected = false
        hosts = []
        preferences.hostID = ""
    }

    func connect() async {
        guard !connecting else { return }
        guard !preferences.serverURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { error = "Enter an explicit BB server URL so conversations stay tied to the right backend."; settingsVisible = true; return }
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

    func newConversation(job: Bool = false, preservingDraft: Bool = false) {
        selectionGeneration = UUID()
        cancelVoiceInput()
        skipInitialContext = false; contextNotice = nil
        dismissVisuals()
        stopSpeaking(); desktop.clearPoints()
        if !preservingDraft { clearCapture(); draft = "" }
        let id = UUID().uuidString
        let session = Conversation(id: id, title: job ? "New agent job" : "New conversation", remoteTitle: "Clicky [\(id)]", hostID: preferences.hostID, serverURL: preferences.serverURL, isJob: job)
        sessions.insert(session, at: 0)
        selectedID = id; reopenableVisual = nil; save()
    }

    func select(_ id: String) {
        selectionGeneration = UUID()
        cancelVoiceInput()
        skipInitialContext = false; contextNotice = nil
        dismissVisuals()
        selectedID = id; draft = ""; clearCapture(); desktop.clearPoints(); stopSpeaking()
        if let requestID = selected?.visualRequest?.id { dismissedVisualRequestIDs.insert(requestID) }
        loadSavedVisualForSelection()
        Task { await refresh() }
    }

    func send(speakReply: Bool = false) async {
        guard canSend, !sending else { return }
        stopSpeaking()
        sending = true
        defer { sending = false }
        while refreshing { try? await Task.sleep(for: .milliseconds(100)); if Task.isCancelled { return } }
        guard !preferences.hostID.isEmpty else {
            error = "Choose the machine that will run your assistant in Settings."
            settingsVisible = true
            return
        }
        if selected == nil { newConversation(preservingDraft: true) }
        guard let id = selectedID, let index = sessions.firstIndex(where: { $0.id == id }) else { return }
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let generation = connectionGeneration
        let selection = selectionGeneration
        let transport = client
        let manualCapture = capture
        var sentCapture = manualCapture
        var automaticCapture: CapturedScreen?
        var contextJSON: String?
        var contextSummary: String?
        defer { if let automaticCapture { desktop.discardCapture(automaticCapture) } }
        if DesktopContextPolicy.include(threadID: sessions[index].threadID, enabled: preferences.includeInitialContext ?? true, skip: skipInitialContext) {
            capturing = true
            let snapshot: InitialDesktopContext
            if let contextCapture { snapshot = await contextCapture(manualCapture) }
            else { snapshot = await desktop.initialContext(manual: manualCapture) }
            capturing = false
            if manualCapture == nil { automaticCapture = snapshot.capture }
            guard generation == connectionGeneration, selection == selectionGeneration, selectedID == id, !Task.isCancelled,
                  let current = sessions.first(where: { $0.id == id }), !current.phase.busy, current.threadID == nil else { return }
            sentCapture = snapshot.capture
            contextJSON = try? snapshot.context.promptJSON()
            contextSummary = snapshot.context.statusDescription
            contextNotice = "Preparing initial context. " + (contextSummary ?? "")
            refreshContextPermissions()
        }
        let display = sentCapture.map(VisualDisplayContext.init(capture:)) ?? VisualDisplayContext.current
        // Reconcile all existing events before starting a new turn. A previous final answer is never reused.
        do {
            if let threadID = sessions.first(where: { $0.id == id })?.threadID { try await readEvents(id: id, threadID: threadID, transport: transport) }
        } catch { self.error = error.localizedDescription; return }
        guard generation == connectionGeneration, selection == selectionGeneration, selectedID == id else { return }
        guard let current = sessions.firstIndex(where: { $0.id == id }), !sessions[current].phase.busy else { return }
        dismissVisuals()
        reopenableVisual = nil
        sessions[current].visualRequest = VisualRequest(id: UUID().uuidString, afterSequence: sessions[current].sequence,
            display: display, hadScreenshot: sentCapture != nil)
        visualStreams[id] = VisualStream()
        assistantText[id] = [:]
        sessions[current].speakReplyForCurrentTurn = speakReply
        if preferences.speakReplies || speakReply, let requestID = sessions[current].visualRequest?.id {
            speechOwner = (id, requestID)
            speechRaw = [:]; speechOrder = []; speechAccumulator = SpeechAccumulator(); speechStarted = false; speechFailed = false
        }
        sessions[current].sentAfterSequence = sessions[current].sequence
        sessions[current].rootTurnID = nil
        sessions[current].completionStatus = nil
        sessions[current].phase = .sending
        sessions[current].entries.append(ChatEntry(id: "pending-\(UUID().uuidString)", role: "user", text: text))
        if sessions[current].threadID == nil {
            sessions[current].hostID = preferences.hostID
            sessions[current].title = String(text.prefix(52))
            sessions[current].remoteTitle = "Clicky · \(String(text.prefix(38))) [\(id)]"
        }
        draft = ""; capture = nil; error = nil
        defer { if automaticCapture == nil, let sentCapture { desktop.discardCapture(sentCapture) } }
        // This durable record is also the recovery key if spawn succeeds but its response is lost.
        save()
        turnCaptures.removeValue(forKey: id)
        guideReplies.removeValue(forKey: id)
        let record = sessions[current]
        let prompt: String
        do {
            let base: String
            let visuals: String
            if let instructionsLoader { (base, visuals) = try instructionsLoader() }
            else {
                guard let url = Bundle.main.url(forResource: "companion", withExtension: "md"),
                      let visualURL = Bundle.main.url(forResource: "companion-visuals", withExtension: "md") else { throw CocoaError(.fileNoSuchFile) }
                base = try String(contentsOf: url, encoding: .utf8)
                visuals = try String(contentsOf: visualURL, encoding: .utf8)
            }
            var instructions = base
            if let request = record.visualRequest {
                instructions += "\n\n" + visuals
                instructions += "\nClicky request: \(request.id)"
            }
            prompt = DesktopContextPolicy.prompt(instructions: instructions, mode: record.isJob ? "Agent job" : "Conversation", screenshot: sentCapture != nil, contextJSON: contextJSON, question: text)
        } catch {
            update(id) { $0.phase = .failed }; self.error = "Companion instructions are missing. Rebuild the app bundle."
            if let contextSummary { contextNotice = "Initial context was not sent. " + contextSummary }
            save(); return
        }
        do {
            if let threadID = record.threadID {
                _ = try await transport.tell(threadID: threadID, prompt: prompt, imageURLs: sentCapture.map { [$0.url] } ?? [])
            } else {
                let thread = try await transport.spawn(prompt: prompt, title: record.remoteTitle, target: .personal(hostID: record.hostID), imageURLs: sentCapture.map { [$0.url] } ?? [])
                update(id) { $0.threadID = thread.id }
            }
            update(id) { $0.phase = .running }
            if let contextSummary { contextNotice = "Initial context sent and saved in the BB thread. " + contextSummary }
            if let sentCapture { turnCaptures[id] = sentCapture }
        } catch BBClientError.invalidConfiguration(let reason) {
            update(id) { $0.phase = .failed }
            draft = text
            self.error = reason
            if let contextSummary { contextNotice = "Initial context was not sent. " + contextSummary }
        } catch BBClientError.commandFailed(let reason, mayHaveSucceeded: false) {
            update(id) { $0.phase = .failed; $0.entries.removeAll { $0.id.hasPrefix("pending-") && $0.text == text } }
            draft = text; self.error = reason
            if let contextSummary { contextNotice = "Initial context was not sent. " + contextSummary }
        } catch {
            update(id) { $0.phase = .deliveryUnknown }
            self.error = "Delivery could not be confirmed. Refresh to recover the BB thread; do not resend automatically. \(error.localizedDescription)"
            if let contextSummary { contextNotice = "Initial context delivery is unconfirmed. " + contextSummary }
        }
        save(); sending = false; startMonitoring(restart: true); await refresh()
    }

    func refresh(reconcileStatus: Bool = true) async {
        guard connected, !refreshing, !sending else { return }
        refreshing = true
        defer { refreshing = false }
        let transport = client
        let generation = connectionGeneration
        let server = preferences.serverURL
        let statusDue = reconcileStatus || ConversationPolling.statusDue(elapsed: Date().timeIntervalSince(lastStatusRefreshAt))
        do {
            let pending = sessions.filter { $0.serverURL == server && $0.threadID == nil && $0.phase == .deliveryUnknown }
            if statusDue, !pending.isEmpty {
                let candidates = try await transport.listThreads(projectID: "proj_personal")
                guard generation == connectionGeneration else { return }
                for session in pending {
                    let matches = candidates.filter { $0.title == session.remoteTitle }
                    if matches.count == 1, let match = matches.first { update(session.id) { $0.threadID = match.id; $0.phase = .running } }
                }
            }
            let fastID = fastSessionID
            let visible = sessions.filter {
                $0.serverURL == server && $0.threadID != nil && ($0.phase.busy || $0.id == selectedID) && (statusDue || $0.id == fastID)
            }.sorted { $0.id == fastID && $1.id != fastID }
            guard !visible.isEmpty else { return }
            for session in visible {
                guard let threadID = session.threadID else { continue }
                do { try await readEvents(id: session.id, threadID: threadID, transport: transport) }
                catch { self.error = "Could not refresh \(session.title). Open it in BB. \(error.localizedDescription)" }
                guard generation == connectionGeneration else { return }
            }
            let becameTerminal = visible.contains { prior in
                prior.phase.busy && sessions.first(where: { $0.id == prior.id })?.phase.busy == false
            }
            guard statusDue || ConversationPolling.statusDue(elapsed: Date().timeIntervalSince(lastStatusRefreshAt), becameTerminal: becameTerminal) else {
                if Date().timeIntervalSince(lastSavedAt) >= ConversationPolling.checkpointInterval,
                   visible.contains(where: { prior in sessions.first(where: { $0.id == prior.id })?.sequence != prior.sequence }) { save() }
                return
            }
            // Read current state after the event page, so historical completion cannot override a newer active turn.
            let statuses = try await transport.listThreads(ids: visible.compactMap(\.threadID))
            guard generation == connectionGeneration else { return }
            lastStatusRefreshAt = Date()
            for session in visible {
                if let remote = statuses.first(where: { $0.id == session.threadID }) {
                    if remote.status == "idle", speechOwner?.sessionID == session.id,
                       sessions.first(where: { $0.id == session.id })?.completionStatus == nil, let threadID = session.threadID {
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
                    error = "This conversation is no longer available in BB."
                }
                if speechOwner?.sessionID == session.id,
                   let phase = sessions.first(where: { $0.id == session.id })?.phase, !phase.busy {
                    // Interruption can settle through thread status without a completion event.
                    stopSpeaking()
                }
            }
            save()
        } catch {
            guard generation == connectionGeneration else { return }
            connectionFailed("BB is unavailable. Your conversation is saved. \(error.localizedDescription)")
        }
    }

    private func readEvents(id: String, threadID: String, transport: BBClient) async throws {
        for _ in 0..<100 {
            guard let session = sessions.first(where: { $0.id == id }) else { return }
            let events = try await transport.events(threadID: threadID, afterSequence: session.sequence)
            var groupedVisualDelta = ""
            for (offset, event) in events.enumerated() {
                update(id) { $0.sequence = max($0.sequence, event.seq) }
                switch event.kind {
                case let .turnStarted(isRoot):
                    if isRoot, let turnID = event.turnID {
                        let boundTurnID = sessions.first(where: { $0.id == id })?.visualRequest?.turnID
                        if boundTurnID == nil || boundTurnID == turnID {
                            update(id) { $0.rootTurnID = turnID; $0.phase = .running }
                        }
                    }
                case let .turnInputAccepted(clientRequestID):
                    if let request = sessions.first(where: { $0.id == id })?.visualRequest,
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
                            s.entries.append(ChatEntry(id: event.id, role: "user", text: visible, turnID: event.turnID))
                        }
                    }
                case let .assistantDelta(itemID, text):
                    guard let turnID = event.turnID, turnID == sessions.first(where: { $0.id == id })?.rootTurnID else { continue }
                    feedSpeech(id: id, itemID: itemID, text: text, authoritative: false)
                    if sessions.first(where: { $0.id == id })?.visualRequest?.turnID == turnID {
                        groupedVisualDelta += text
                        if offset + 1 < events.count, events[offset + 1].turnID == turnID,
                           case let .assistantDelta(nextItemID, _) = events[offset + 1].kind, nextItemID == itemID { continue }
                        let group = groupedVisualDelta; groupedVisualDelta = ""
                        if ingestVisual(id: id, event: event, itemID: itemID, text: group, authoritative: false) { continue }
                    }
                    recordAssistantText(id: id, event: event, itemID: itemID, text: text, authoritative: false)
                case let .assistantMessage(itemID, text):
                    guard let turnID = event.turnID, turnID == sessions.first(where: { $0.id == id })?.rootTurnID else { continue }
                    feedSpeech(id: id, itemID: itemID, text: text, authoritative: true)
                    if ingestVisual(id: id, event: event, itemID: itemID, text: text, authoritative: true) { continue }
                    recordAssistantText(id: id, event: event, itemID: itemID, text: text, authoritative: true)
                case let .turnCompleted(status, message):
                    guard let current = sessions.first(where: { $0.id == id }), let turnID = event.turnID, turnID == current.rootTurnID else { continue }
                    update(id) { $0.phase = status == "completed" ? .ready : .failed; $0.completionStatus = status }
                    if let message, !message.isEmpty { error = message }
                    if let request = current.visualRequest, request.turnID == turnID {
                        finishVisual(id: id, successful: status == "completed")
                    }
                    if status == "completed", let baseline = current.sentAfterSequence, event.seq > baseline,
                       let reply = current.entries.last(where: { $0.role == "assistant" && $0.turnID == turnID })?.text {
                        if turnCaptures[id] != nil { guideReplies[id] = reply }
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
        guard let owner = speechOwner, owner.sessionID == id, id == selectedID,
              let current = selected, owner.requestID == current.visualRequest?.id else { return }
        if speechRaw[itemID] == nil { speechOrder.append(itemID) }
        let raw = authoritative ? text : (speechRaw[itemID] ?? "") + text
        speechRaw[itemID] = raw
        for chunk in speechAccumulator.consume(itemID: itemID, text: raw, complete: authoritative) { speakChunk(chunk) }
    }
    private func speakChunk(_ text: String) {
        guard !speechFailed else { return }
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

    private func update(_ id: String, _ mutation: (inout Conversation) -> Void) {
        if let i = sessions.firstIndex(where: { $0.id == id }) { mutation(&sessions[i]) }
    }

    var canReopenVisual: Bool { reopenableVisual != nil }

    private func loadSavedVisualForSelection() {
        guard let session = selected, let request = session.visualRequest else { reopenableVisual = nil; return }
        let saved = visualStore.load(sessionID: session.id, requestID: request.id)
        reopenableVisual = saved?.kind == .overlay && (turnCaptures[session.id] == nil || request.display?.matchingScreen == nil) ? nil : saved
    }

    func openVisuals() {
        guard let document = reopenableVisual, !document.nodes.isEmpty else { return }
        visualDocument = document
        visualIsComplete = true
        visualWarning = nil
        if let requestID = selected?.visualRequest?.id { dismissedVisualRequestIDs.remove(requestID) }
        onVisualPresentation?()
    }

    func dismissVisuals() {
        if let requestID = selected?.visualRequest?.id { dismissedVisualRequestIDs.insert(requestID) }
        visualDocument = nil; selectedVisualNodeID = nil; visualWarning = nil; visualIsComplete = false
        onVisualDismiss?()
    }

    var visualDisplay: VisualDisplayContext? { selected?.visualRequest?.display }
    private func recordAssistantText(id: String, event: BBEvent, itemID: String, text: String, authoritative: Bool) {
        let persisted = sessions.first(where: { $0.id == id })?.entries.first(where: { $0.id == itemID })?.text ?? ""
        let raw = authoritative ? text : (assistantText[id]?[itemID] ?? persisted) + text
        assistantText[id, default: [:]][itemID] = raw
        let readable = VisualStream.visibleText(raw)
        update(id) { session in
            if let i = session.entries.firstIndex(where: { $0.id == itemID }) { session.entries[i].text = readable }
            else { session.entries.append(ChatEntry(id: itemID, role: "assistant", text: readable, turnID: event.turnID)) }
        }
    }

    private func ingestVisual(id: String, event: BBEvent, itemID: String, text: String, authoritative: Bool) -> Bool {
        guard let session = sessions.first(where: { $0.id == id }), let request = session.visualRequest,
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
            else { s.entries.append(ChatEntry(id: itemID, role: "assistant", text: readable, turnID: event.turnID)) }
        }
        guard id == selectedID, session.serverURL == preferences.serverURL,
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
        reopenableVisual = nil
        if wasPresented { onVisualDismiss?() }
    }

    private func finishVisual(id: String, successful: Bool) {
        guard let session = sessions.first(where: { $0.id == id }), let request = session.visualRequest,
              let stream = visualStreams[id] else { return }
        let isSelected = id == selectedID && session.serverURL == preferences.serverURL
        let isPresented = isSelected && !dismissedVisualRequestIDs.contains(request.id) && visualDocument != nil
        guard stream.hasVisualContent else {
            // Plain text is a complete answer. An optional visual is not a missing result.
            if isSelected { clearReplacedVisual() }
            return
        }
        if successful, let document = stream.completedDocument,
           document.kind != .overlay || (request.hadScreenshot && request.display?.matchingScreen != nil) {
            do {
                try visualStore.save(document, sessionID: id, requestID: request.id)
                if isSelected { reopenableVisual = document }
            } catch { if isPresented { visualWarning = "Could not save this visual: \(error.localizedDescription)" } }
            if isPresented { visualIsComplete = true }
        } else if isPresented {
            visualIsComplete = false
            visualWarning = successful ? (stream.warning ?? "BB did not finish a valid visual. Ask a follow-up or open the conversation in BB.") : "Generation stopped. This is an unfinished preview."
        }
    }

    func showGuides() {
        guard let id = selectedID, let screen = turnCaptures[id], let reply = guideReplies[id] else { return }
        desktop.showPoints(in: reply, for: screen)
    }
    var hasGuides: Bool {
        guard let id = selectedID, turnCaptures[id] != nil, let reply = guideReplies[id] else { return false }
        return !ScreenPoint.parse(in: reply).points.isEmpty
    }

    func stop() async {
        cancelVoiceInput(); stopSpeaking(); desktop.clearPoints()
        guard let s = selected, let threadID = s.threadID else { return }
        do { try await client.stop(threadID: threadID); update(s.id) { $0.phase = .failed }; save() }
        catch { self.error = "Could not confirm stop. Open BB to check the running task. \(error.localizedDescription)" }
    }

    func openInBB() async {
        guard let id = selected?.threadID else { return }
        do { try await client.open(threadID: id) } catch { self.error = error.localizedDescription }
    }

    func refreshContextPermissions() {
        accessibilityAllowed = desktop.accessibilityAllowed
        screenCaptureAllowed = desktop.screenCaptureAllowed
    }
    func requestAccessibility() { desktop.requestAccessibility(); refreshContextPermissions() }
    func requestScreenCapture() { desktop.requestScreenCapture(); refreshContextPermissions() }
    var offersInitialContext: Bool {
        selected?.threadID == nil && (preferences.includeInitialContext ?? true)
    }

    func takeCapture() async {
        guard !capturing else { return }
        capturing = true
        defer { capturing = false }
        do { clearCapture(); capture = try await desktop.captureScreen() }
        catch { self.error = error.localizedDescription }
    }
    func clearCapture() { if let capture { desktop.discardCapture(capture) }; capture = nil }

    func beginRecording(autoSend: Bool = false) async {
        // A new hold always silences the previous answer, including a running BB turn.
        stopSpeaking()
        guard !recording, !requestingMicrophone, !transcribing, !sending else { return }
        if autoSend, !connected { error = "Connect to BB before asking a voice question."; settingsVisible = true; return }
        if autoSend {
            clearCapture()
            if selected == nil { newConversation(preservingDraft: true) }
        }
        let request = VoiceRequestContext(autoSend: autoSend, sessionID: selectedID, connectionGeneration: connectionGeneration)
        voiceRequest = request; requestingMicrophone = true; error = nil
        recordingStartedAt = Date()
        recordingLimit = Task {
            try? await Task.sleep(for: .seconds(30))
            guard !Task.isCancelled else { return }
            recordingLimit = nil
            await endRecording(autoSendAllowed: false)
        }
        defer { if voiceRequest?.id == request.id { requestingMicrophone = false } }
        do {
            try await voice.startListening()
            guard voiceRequest?.id == request.id else { return }
            recording = true; requestingMicrophone = false
            if let allowed = voiceRequest?.releaseAllowed { await endRecording(autoSendAllowed: allowed) }
        } catch is CancellationError { }
        catch {
            if voiceRequest?.id == request.id { cancelVoiceInput(); self.error = error.localizedDescription; settingsVisible = true }
        }
    }

    func endRecording(autoSendAllowed: Bool = true) async {
        if requestingMicrophone {
            // A quick question can finish before the WebSocket handshake. Stop
            // capture now, then drain its buffered audio after session_started.
            if voice.hasLiveCapture { voiceRequest?.releaseAllowed = autoSendAllowed; voice.releaseCapture() }
            else { cancelVoiceInput() }
            return
        }
        guard recording, let request = voiceRequest else { return }
        let duration = recordingStartedAt.map { Date().timeIntervalSince($0) } ?? 0
        recordingStartedAt = nil
        recording = false; recordingLimit?.cancel()
        if request.autoSend, duration < 0.3 { cancelVoiceInput(); return }
        transcribing = true
        defer { if voiceRequest?.id == request.id { voiceRequest = nil; transcribing = false } }
        do {
            let text = try await voice.finishListening()
            guard voiceRequest?.id == request.id, request.connectionGeneration == connectionGeneration, request.sessionID == selectedID else { return }
            guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw VoiceProtocolError.noSpeech }
            let preservedDraft = draft
            transcribing = false
            if request.autoSend, autoSendAllowed, selected?.phase.busy != true {
                draft = text
                await send(speakReply: true)
                guard request.connectionGeneration == connectionGeneration, request.sessionID == selectedID else { return }
                if draft.isEmpty { draft = preservedDraft }
                else if draft == text, !preservedDraft.isEmpty { draft = preservedDraft + "\n\n" + text }
            } else {
                draft = preservedDraft.isEmpty ? text : preservedDraft + "\n\n" + text
                if !autoSendAllowed { error = "Recording reached 30 seconds. Review the transcript before sending." }
                else if request.autoSend { error = "Your question is in the draft. BB is still working; send it when ready, or stop the current task." }
            }
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
        visibleSessions.first(where: {
            ConversationPolling.isFast(phase: $0.phase, foreground: $0.id == selectedID || $0.id == speechOwner?.sessionID, isJob: $0.isJob)
        })?.id
    }
    func startMonitoring(restart: Bool = false) {
        if restart { monitor?.cancel(); monitor = nil }
        guard monitor == nil else { return }
        monitor = Task { [weak self] in
            while !Task.isCancelled {
                let interval = self?.fastSessionID != nil ? ConversationPolling.fastInterval : ConversationPolling.statusInterval
                try? await Task.sleep(for: .seconds(interval))
                guard !Task.isCancelled, let self else { return }
                let stillBusy = self.visibleSessions.contains(where: { $0.phase.busy })
                if self.connected && stillBusy {
                    await self.refresh(reconcileStatus: false)
                } else if !self.connected && self.retryCount > 0 && self.retryCount <= 3 && Date() >= self.nextRetryAt && (self.panelVisible || stillBusy) { await self.connect() }
            }
        }
    }
    func shutdown() { cancelVoiceInput(); stopSpeaking(); voice.shutdown(); onVisualDismiss?(); monitor?.cancel(); recordingLimit?.cancel(); clearCapture(); desktop.shutdown(); save() }
}
