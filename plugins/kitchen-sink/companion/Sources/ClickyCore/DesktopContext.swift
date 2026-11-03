import Foundation

public struct ContextRect: Codable, Equatable, Sendable {
    public let x: Double, y: Double, width: Double, height: Double
    public init?(x: Double, y: Double, width: Double, height: Double) {
        guard [x, y, width, height].allSatisfy(\.isFinite), width > 0, height > 0 else { return nil }
        self.x = x; self.y = y; self.width = width; self.height = height
    }
    public func intersects(_ other: Self) -> Bool {
        x < other.x + other.width && x + width > other.x && y < other.y + other.height && y + height > other.y
    }
    public func normalized(to display: Self) -> Self? {
        Self(x: (x - display.x) * 1000 / display.width, y: (y - display.y) * 1000 / display.height,
             width: width * 1000 / display.width, height: height * 1000 / display.height)
    }
}

public struct AccessibleContextNode: Codable, Equatable, Sendable {
    public var id: Int
    public var parent: Int?
    public var role: String
    public var label: String?
    public var value: String?
    public var help: String?
    public var selectedText: String?
    public var enabled: Bool?
    public var focused: Bool?
    public var selected: Bool?
    public var expanded: Bool?
    public var bounds: ContextRect
    public var imageBounds: ContextRect?
    public init(id: Int, parent: Int? = nil, role: String, label: String? = nil, value: String? = nil, help: String? = nil,
                selectedText: String? = nil, enabled: Bool? = nil, focused: Bool? = nil, selected: Bool? = nil,
                expanded: Bool? = nil, bounds: ContextRect) {
        self.id = id; self.parent = parent; self.role = role; self.label = label; self.value = value; self.help = help
        self.selectedText = selectedText; self.enabled = enabled; self.focused = focused; self.selected = selected
        self.expanded = expanded; self.bounds = bounds
    }
    public static func isSecure(role: String, subrole: String?) -> Bool {
        role == "AXSecureTextField" || subrole == "AXSecureTextField"
    }
}

public struct DesktopContext: Codable, Equatable, Sendable {
    public enum Access: String, Codable, Sendable { case available, permissionDenied, unavailable, timedOut, displayMismatch }
    public var application: String
    public var bundleID: String?
    public var capturedAt: Date
    public var window: String?
    public var windowBounds: ContextRect?
    public var accessibility: Access
    public var nodes: [AccessibleContextNode] = []
    public var truncated = false
    public var screenshot: Access = .unavailable
    public var screenshotAt: Date?
    public var displayID: UInt32?
    public var displayBounds: ContextRect?
    public var imageWidth: Int?
    public var imageHeight: Int?
    public init(application: String, bundleID: String? = nil, capturedAt: Date = Date(), accessibility: Access) {
        self.application = application; self.bundleID = bundleID; self.capturedAt = capturedAt; self.accessibility = accessibility
    }
    public var statusDescription: String {
        func describe(_ state: Access, subject: String, permission: String) -> String {
            switch state {
            case .available: "\(subject) ready."
            case .permissionDenied: "\(permission) permission is needed for \(subject.lowercased())."
            case .timedOut: "\(subject) timed out and was omitted."
            case .unavailable: "\(subject) unavailable."
            case .displayMismatch: "\(subject) omitted because the screenshot is from another display."
            }
        }
        return describe(accessibility, subject: "Window text", permission: "Accessibility") + " "
            + describe(screenshot, subject: "Display screenshot", permission: "Screen Recording")
    }
    public func promptJSON() throws -> String {
        let encoder = JSONEncoder(); encoder.dateEncodingStrategy = .iso8601; encoder.outputFormatting = [.sortedKeys]
        var copy = self
        copy.application = String(copy.application.prefix(120)); copy.bundleID = copy.bundleID.map { String($0.prefix(200)) }
        copy.window = copy.window.map { String($0.prefix(200)) }
        if copy.nodes.count > 120 { copy.nodes = Array(copy.nodes.prefix(120)); copy.truncated = true }
        for index in copy.nodes.indices {
            copy.nodes[index].role = String(copy.nodes[index].role.prefix(80))
            copy.nodes[index].label = copy.nodes[index].label.map { String($0.prefix(300)) }
            copy.nodes[index].value = copy.nodes[index].value.map { String($0.prefix(500)) }
            copy.nodes[index].help = copy.nodes[index].help.map { String($0.prefix(150)) }
            copy.nodes[index].selectedText = copy.nodes[index].selectedText.map { String($0.prefix(200)) }
        }
        while true {
            let data = try encoder.encode(copy)
            if data.count <= 12_000 { return String(decoding: data, as: UTF8.self) }
            guard !copy.nodes.isEmpty else { throw CocoaError(.coderInvalidValue) }
            copy.nodes.removeLast(); copy.truncated = true
        }
    }
}

public enum DesktopContextPolicy {
    public static func include(threadID: String?, enabled: Bool, skip: Bool) -> Bool { threadID == nil && enabled && !skip }
    public static func prompt(instructions: String, mode: String, screenshot: Bool, contextJSON: String?, question: String) -> String {
        let context = contextJSON.map { "\n\nDesktop context snapshot (JSON):\n" + $0 } ?? ""
        return "\(instructions)\n\nMode: \(mode).\nScreen attached to this message: \(screenshot ? "yes" : "no").\(context)\n\nUser request:\n\(question)"
    }
}
