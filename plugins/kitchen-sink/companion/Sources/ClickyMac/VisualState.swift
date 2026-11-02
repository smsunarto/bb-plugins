import AppKit
import ClickyCore

struct VisualRequest: Codable {
    var binding: VisualTurnBinding
    let display: VisualDisplayContext?
    let hadScreenshot: Bool
    var id: String { binding.nonce }
    var afterSequence: Int { binding.afterSequence }
    var clientRequestID: String? { binding.clientRequestID }
    var turnID: String? { binding.turnID }

    init(id: String, afterSequence: Int, display: VisualDisplayContext?, hadScreenshot: Bool) {
        binding = VisualTurnBinding(nonce: id, afterSequence: afterSequence)
        self.display = display; self.hadScreenshot = hadScreenshot
    }
}

/// Display identity belongs to the native request, never to generated content.
struct VisualDisplayContext: Codable, Equatable {
    let id: UInt32
    let x: Double
    let y: Double
    let width: Double
    let height: Double

    init?(screen: NSScreen?) {
        guard let screen, let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { return nil }
        id = number.uint32Value
        x = screen.frame.minX; y = screen.frame.minY
        width = screen.frame.width; height = screen.frame.height
    }

    init(capture: CapturedScreen) {
        id = capture.displayID
        x = capture.frame.minX; y = capture.frame.minY
        width = capture.frame.width; height = capture.frame.height
    }

    var matchingScreen: NSScreen? {
        NSScreen.screens.first {
            let number = $0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber
            return number?.uint32Value == id && $0.frame == CGRect(x: x, y: y, width: width, height: height)
        }
    }

    static var current: Self? {
        Self(screen: NSScreen.screens.first { $0.frame.contains(NSEvent.mouseLocation) } ?? NSScreen.main)
    }
}

/// Scene corruption cannot invalidate the user's conversations or connection settings.
struct VisualSnapshotStore {
    let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("ClickyBB/visuals", isDirectory: true)

    private struct Snapshot: Codable {
        let requestID: String
        let document: VisualDocument
    }

    func load(sessionID: String, requestID: String) -> VisualDocument? {
        guard let url = location(sessionID), let data = try? Data(contentsOf: url), data.count <= 256 * 1024,
              let snapshot = try? JSONDecoder().decode(Snapshot.self, from: data), snapshot.requestID == requestID,
              let validated = try? snapshot.document.validated() else { return nil }
        return validated
    }

    func save(_ document: VisualDocument, sessionID: String, requestID: String) throws {
        guard let url = location(sessionID) else { throw CocoaError(.fileWriteInvalidFileName) }
        let validated = try document.validated()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try JSONEncoder().encode(Snapshot(requestID: requestID, document: validated)).write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    private func location(_ id: String) -> URL? {
        guard UUID(uuidString: id) != nil else { return nil }
        return directory.appendingPathComponent(id).appendingPathExtension("json")
    }
}
