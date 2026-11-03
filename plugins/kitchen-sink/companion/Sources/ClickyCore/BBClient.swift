import Foundation
import Darwin

/// The CLI owns authentication and remote-host routing. This adapter never stores credentials.
public struct BBClient: Sendable {
    public let configuration: BBConfiguration

    public init(configuration: BBConfiguration = BBConfiguration()) {
        self.configuration = configuration
    }

    public func projects() async throws -> [BBProject] {
        try await decode(["project", "list", "--include-personal", "--json"])
    }

    public func hosts() async throws -> [BBHost] {
        try await decode(["machine", "list", "--json"])
    }

    public func environments(projectID: String) async throws -> [BBEnvironment] {
        try await decode(["environment", "list", "--project", projectID, "--status", "ready", "--json"])
    }

    public func listThreads(projectID: String? = nil, environmentID: String? = nil, ids: [String] = []) async throws -> [BBThread] {
        guard ids.count <= 200 else { throw BBClientError.invalidConfiguration("Select at most 200 conversations.") }
        var args = ["thread", "list", "--json"]
        if let projectID { args += ["--project", projectID] }
        if let environmentID { args += ["--environment", environmentID] }
        for id in ids { args += ["--thread", id] }
        return try await decode(args)
    }

    public func spawn(prompt: String, title: String, target: BBTarget, providerID: String? = nil, model: String? = nil, imageURLs: [URL] = []) async throws -> BBThread {
        var args = ["thread", "spawn", "--project", target.projectID, "--title", title, "--permission-mode", "accept-edits", "--json"]
        switch target {
        case .environment(_, let environmentID):
            guard !environmentID.isEmpty else { throw BBClientError.invalidConfiguration("Select a BB environment.") }
            args += ["--environment", environmentID]
        case .personal(let hostID):
            guard !hostID.isEmpty else { throw BBClientError.invalidConfiguration("Select the Mac that will run your assistant.") }
            args += ["--new-environment", "personal", "--machine", hostID]
        }
        if let providerID, !providerID.isEmpty { args += ["--provider", providerID] }
        if let model, !model.isEmpty { args += ["--model", model] }
        for image in imageURLs { args += ["--image", image.path] }
        return try await decode(args, prompt: prompt, promptFlag: "--prompt-file", isWrite: true)
    }

    public func tell(threadID: String, prompt: String, imageURLs: [URL] = []) async throws -> BBSendReceipt {
        var args = ["thread", "tell", threadID, "--mode", "steer", "--json"]
        for image in imageURLs { args += ["--image", image.path] }
        return try await decode(args, prompt: prompt, promptFlag: "--message-file", isWrite: true)
    }

    public func events(threadID: String, afterSequence: Int = 0, limit: Int = 200) async throws -> [BBEvent] {
        guard afterSequence >= 0, (1...500).contains(limit) else {
            throw BBClientError.invalidConfiguration("Invalid conversation page.")
        }
        var pageSize = limit
        while true {
            do {
                return try await decode(["thread", "log", threadID, "--json", "--after-seq", String(afterSequence), "--limit", String(pageSize)])
            } catch BBClientError.responseTooLarge where pageSize > 1 {
                // Retry only this read, at the same cursor. The caller drains until an empty page.
                pageSize = max(1, (pageSize + 1) / 2)
            }
        }
    }

    public func output(threadID: String) async throws -> String? {
        let response: Output = try await decode(["thread", "output", threadID, "--json"])
        return response.output
    }

    public func stop(threadID: String) async throws {
        _ = try await run(["thread", "stop", threadID, "--json"], isWrite: true)
    }

    public func open(threadID: String) async throws {
        _ = try await run(["thread", "open", threadID, "--json"], isWrite: true)
    }

    public func transcribe(audioURL: URL) async throws -> String {
        let result: Transcription = try await decode(["voice", "transcribe", audioURL.path, "--type", "audio/mp4", "--json"])
        return result.text
    }

    private struct Output: Decodable { let output: String? }
    private struct Transcription: Decodable { let text: String }
    private struct Failure: Decodable {
        let code: String?
        let message: String?
        let error: Detail?
        struct Detail: Decodable { let code: String?; let message: String? }

        var rejectionIsDefinitive: Bool {
            guard let code = error?.code ?? code else { return false }
            return [
                "invalid_request", "invalid_json", "invalid_argument", "missing_required",
                "unauthorized", "forbidden", "not_found", "thread_not_found", "thread_not_writable",
                "project_not_found", "environment_not_found", "host_not_found",
                "thread_environment_unavailable", "http_400", "http_401", "http_403", "http_404", "http_422"
            ].contains(code)
        }
    }

    private func decode<T: Decodable>(_ arguments: [String], prompt: String? = nil, promptFlag: String? = nil, isWrite: Bool = false) async throws -> T {
        let data = try await run(arguments, prompt: prompt, promptFlag: promptFlag, isWrite: isWrite)
        do { return try JSONDecoder().decode(T.self, from: data) }
        catch { throw BBClientError.invalidResponse }
    }

    /// Each invocation owns its files and process. No shell, shared pipes, or retries.
    private func run(_ arguments: [String], prompt: String? = nil, promptFlag: String? = nil, isWrite: Bool = false) async throws -> Data {
        try Task.checkCancellation()
        let executable = configuration.executablePath
        let runtime = configuration.runtimeExecutablePath.flatMap { $0.isEmpty ? nil : $0 }
        let validCLI = runtime == nil ? FileManager.default.isExecutableFile(atPath: executable) : FileManager.default.isReadableFile(atPath: executable)
        guard executable.hasPrefix("/"), validCLI else {
            throw BBClientError.invalidConfiguration("Choose the installed BB command in Settings.")
        }
        if let runtime {
            guard runtime.hasPrefix("/"), FileManager.default.isExecutableFile(atPath: runtime) else {
                throw BBClientError.invalidConfiguration("Choose a valid BB runtime executable in Settings.")
            }
        }
        guard configuration.timeoutSeconds.isFinite, configuration.timeoutSeconds > 0 else {
            throw BBClientError.invalidConfiguration("BB timeout must be a positive number of seconds.")
        }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("clicky-bb-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: directory) }
        let stdoutURL = directory.appendingPathComponent("stdout")
        let stderrURL = directory.appendingPathComponent("stderr")
        FileManager.default.createFile(atPath: stdoutURL.path, contents: nil, attributes: [.posixPermissions: 0o600])
        FileManager.default.createFile(atPath: stderrURL.path, contents: nil, attributes: [.posixPermissions: 0o600])
        let stdout = try FileHandle(forWritingTo: stdoutURL)
        let stderr = try FileHandle(forWritingTo: stderrURL)
        defer { try? stdout.close(); try? stderr.close() }
        var args = arguments
        if let prompt, let promptFlag {
            let promptURL = directory.appendingPathComponent("prompt.txt")
            try Data(prompt.utf8).write(to: promptURL)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: promptURL.path)
            args += [promptFlag, promptURL.path]
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: runtime ?? executable)
        process.arguments = runtime == nil ? args : [executable] + args
        process.standardOutput = stdout
        process.standardError = stderr
        process.standardInput = FileHandle.nullDevice
        process.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
        var environment = ProcessInfo.processInfo.environment
        for key in ["BB_CLI", "BB_CLI_REEXEC", "BB_THREAD_ID", "BB_PROJECT_ID", "BB_ENVIRONMENT_ID", "BB_THREAD_STORAGE", "BB_AGENT_ID"] {
            environment.removeValue(forKey: key)
        }
        if let server = configuration.serverURL?.trimmingCharacters(in: .whitespacesAndNewlines), !server.isEmpty {
            guard let url = URL(string: server), ["http", "https"].contains(url.scheme), url.host != nil, url.user == nil, url.password == nil else {
                throw BBClientError.invalidConfiguration("Enter the BB server URL, such as https://your-server.getbb.app.")
            }
            environment["BB_SERVER_URL"] = server
        }
        if runtime != nil { environment["ELECTRON_RUN_AS_NODE"] = "1" }
        process.environment = environment
        try process.run()
        let deadline = ContinuousClock.now.advanced(by: .seconds(configuration.timeoutSeconds))
        do {
            while process.isRunning {
                try Task.checkCancellation()
                if ContinuousClock.now >= deadline { throw BBClientError.timedOut(mayHaveSucceeded: isWrite) }
                try await Task.sleep(for: .milliseconds(40))
            }
            try Task.checkCancellation()
        } catch {
            if process.isRunning { Darwin.kill(process.processIdentifier, SIGKILL) }
            throw error
        }
        let output = try readBounded(stdoutURL)
        guard process.terminationStatus == 0 else {
            let errorData = try readBounded(stderrURL)
            let failure = try? JSONDecoder().decode(Failure.self, from: output)
            if (failure?.error?.code ?? failure?.code) == "event_data_too_large" { throw BBClientError.responseTooLarge }
            let reason = failure?.error?.message ?? failure?.message ?? String(decoding: errorData.prefix(4_096), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            throw BBClientError.commandFailed(reason.isEmpty ? "The BB command failed (exit \(process.terminationStatus))." : reason, mayHaveSucceeded: isWrite && !(failure?.rejectionIsDefinitive ?? false))
        }
        return output
    }

    private func readBounded(_ url: URL) throws -> Data {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        let maxBytes = 8 * 1_024 * 1_024
        let data = try handle.read(upToCount: maxBytes + 1) ?? Data()
        guard data.count <= maxBytes else { throw BBClientError.responseTooLarge }
        return data
    }
}
