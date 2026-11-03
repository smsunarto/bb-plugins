import Foundation
import Testing
@testable import ClickyCore

@Suite struct VisualStreamTests {
    private let scene = #"{"op":"scene","kind":"diagram","title":"How it works"}"#
    private let a = #"{"op":"node","id":"a","shape":"rectangle","position":[200,300],"size":[200,100],"label":"Input","color":"cyan"}"#
    private let b = #"{"op":"node","id":"b","shape":"ellipse","position":[700,300],"size":[200,100],"label":"Output","color":"pink"}"#
    private let edge = #"{"op":"edge","id":"ab","from":"a","to":"b","label":"transform"}"#
    private let done = #"{"op":"done"}"#
    private func fenced(_ lines: [String], closing: Bool = true) -> String {
        "```clicky-visual\n" + lines.joined(separator: "\n") + (closing ? "\n```" : "")
    }

    @Test func partialLinesNeverPublishPartialOperations() throws {
        var stream = VisualStream()
        stream.append(delta: "```clicky-visual\n" + scene + "\n" + String(a.dropLast()), itemID: "one")
        #expect(stream.preview?.nodes.isEmpty == true)
        #expect(stream.warning == nil)
        stream.append(delta: "}\n", itemID: "one")
        #expect(stream.preview?.nodes.map(\.id) == ["a"])
        #expect(stream.preview?.nodes.first?.position == VisualVector(x: 200, y: 300))
        #expect(stream.preview?.nodes.first?.size == VisualVector(x: 200, y: 100, z: 1))
        #expect(stream.completedDocument == nil)
    }

    @Test func allChunkBoundariesReachSameValidatedSnapshot() throws {
        let text = fenced([scene, a, b, edge, done])
        let expected = try #require(parse(text).completedDocument)
        for cut in text.indices {
            var stream = VisualStream()
            stream.append(delta: String(text[..<cut]), itemID: "one")
            stream.append(delta: String(text[cut...]), itemID: "one")
            stream.replace(text: text, itemID: "one")
            #expect(stream.completedDocument == expected)
            #expect(stream.warning == nil)
        }
    }

    @Test func authoritativeReplacementRemovesStaleNodesAndDoesNotDuplicate() {
        var stream = parse(fenced([scene, a, b, edge, done]))
        let replacement = fenced([scene, a, done])
        stream.replace(text: replacement, itemID: "one")
        let revision = stream.revision
        #expect(stream.completedDocument?.nodes.map(\.id) == ["a"])
        #expect(stream.completedDocument?.edges.isEmpty == true)
        stream.replace(text: replacement, itemID: "one")
        #expect(stream.revision == revision)
        stream.replace(text: "No diagram is needed.", itemID: "one")
        #expect(stream.preview == nil)
        #expect(stream.completedDocument == nil)
        #expect(!stream.hasVisualContent)
    }

    @Test func sceneOperationStartsAReplacementSnapshot() {
        let stream = parse(fenced([scene, a, b, edge, done, scene, a, done]))
        #expect(stream.completedDocument?.nodes.map(\.id) == ["a"])
        #expect(stream.completedDocument?.edges.isEmpty == true)
    }

    @Test func upsertsReplaceObjectsWithoutChangingOrder() {
        let changed = a.replacingOccurrences(of: "Input", with: "Revised")
        let stream = parse(fenced([scene, a, b, changed, done]))
        #expect(stream.completedDocument?.nodes.map(\.label) == ["Revised", "Output"])
    }

    @Test func badOperationsRetainPreviewButPreventCompletionUntilReset() {
        var stream = parse(fenced([scene, a, "broken", b, done]))
        #expect(stream.preview?.nodes.count == 2)
        #expect(stream.completedDocument == nil)
        #expect(stream.warning != nil)
        stream.replace(text: fenced([scene, a, "broken", scene, b, done]), itemID: "one")
        #expect(stream.completedDocument?.nodes.map(\.id) == ["b"])
        #expect(stream.warning == nil)
    }

    @Test func edgesMayArriveBeforeNodesButMustResolveAtDone() {
        let good = parse(fenced([scene, edge, a, b, done]))
        #expect(good.completedDocument?.edges.count == 1)
        let bad = parse(fenced([scene, edge, a, done]))
        #expect(bad.preview?.nodes.count == 1)
        #expect(bad.completedDocument == nil)
        #expect(bad.warning != nil)
    }

    @Test func finalMessageFlushesLastUnterminatedLine() {
        var stream = VisualStream()
        let text = fenced([scene, a, done], closing: false)
        stream.append(delta: text, itemID: "one")
        #expect(stream.completedDocument == nil)
        stream.replace(text: text, itemID: "one")
        #expect(stream.completedDocument?.nodes.count == 1)
    }

    @Test func incompleteAndUnknownCommandsNeverComplete() {
        #expect(parse(fenced([scene, a])).completedDocument == nil)
        #expect(parse(fenced([scene, done])).completedDocument == nil)
        #expect(parse(fenced([scene, a, #"{"op":"eval","code":"anything"}"#, done])).completedDocument == nil)
        #expect(parse(fenced([scene, a, done, b])).completedDocument == nil)
        #expect(parse(fenced([a, done])).preview == nil)
    }

    @Test func newestVisualItemReplacesOlderItemAndPlainTextDoesNot() {
        var stream = parse(fenced([scene, a, done]))
        stream.replace(text: "Here is the explanation.", itemID: "two")
        #expect(stream.completedDocument?.nodes.map(\.id) == ["a"])
        stream.replace(text: fenced([scene, b, done]), itemID: "three")
        #expect(stream.completedDocument?.nodes.map(\.id) == ["b"])
        stream.replace(text: fenced([scene, a, b, done]), itemID: "one")
        #expect(stream.completedDocument?.nodes.map(\.id) == ["b"])
    }

    @Test func protocolIsHiddenWhileReadableTextRemains() {
        var stream = VisualStream()
        stream.append(delta: "An explanation.\n```clicky-visual\n" + scene + "\n{\"op\":\"node\"", itemID: "one")
        #expect(stream.displayText(for: "one") == "An explanation.")
        #expect(VisualStream.visibleText("Hello\n```clicky-vis") == "Hello")
        stream.replace(text: "Before\n" + fenced([scene, a, done]) + "\nAfter", itemID: "one")
        #expect(stream.displayText(for: "one") == "Before\nAfter")
    }

    @Test func aggregateByteLimitKeepsLastValidPreviewAndCanRecover() {
        var stream = parse(fenced([scene, a, done]))
        let preview = stream.preview
        stream.append(delta: String(repeating: "x", count: VisualStream.maximumBytes), itemID: "two")
        #expect(stream.preview == preview)
        #expect(stream.completedDocument == nil)
        #expect(stream.warning != nil)
        stream.replace(text: fenced([scene, b, done]), itemID: "one")
        #expect(stream.completedDocument?.nodes.map(\.id) == ["b"])
    }

    @Test func nodeLimitIsEnforcedBeforePublishingExtraObject() {
        let nodes = (0..<97).map { a.replacingOccurrences(of: "\"id\":\"a\"", with: "\"id\":\"n\($0)\"") }
        let stream = parse(fenced([scene] + nodes + [done]))
        #expect(stream.preview?.nodes.count == 96)
        #expect(stream.completedDocument == nil)
    }

    @Test func invalidCoordinatesAndShapesCannotReachRenderer() {
        let invalid = [
            a.replacingOccurrences(of: "[200,300]", with: "[1001,0]"),
            a.replacingOccurrences(of: "[200,300]", with: "[1e309,0]"),
            a.replacingOccurrences(of: "[200,300]", with: "[2]"),
            a.replacingOccurrences(of: "[200,100]", with: "[-1,0]"),
            a.replacingOccurrences(of: "rectangle", with: "box"),
            a.replacingOccurrences(of: "cyan", with: "javascript:alert(1)"),
        ]
        for node in invalid {
            let stream = parse(fenced([scene, node, done]))
            #expect(stream.preview?.nodes.isEmpty == true)
            #expect(stream.completedDocument == nil)
        }
    }

    @Test func boundedMeshAndAnimationAreDecodedAsValues() throws {
        let start = #"{"op":"scene","kind":"scene3d","title":"Triangle"}"#
        let node = #"{"op":"node","id":"mesh","shape":"mesh","position":[0,0,0],"size":[1,1,1],"vertices":[[0,0,0],[1,0,0],[0,1,0]],"triangles":[0,1,2],"animation":{"translation":[0,1,0],"rotation":[0,90,0],"duration":2}}"#
        let document = try #require(parse(fenced([start, node, done])).completedDocument)
        #expect(document.nodes.first?.vertices.count == 3)
        #expect(document.nodes.first?.animation?.rotation.y == 90)
        #expect(parse(fenced([start, node.replacingOccurrences(of: "[0,1,2]", with: "[0,1,9]"), done])).completedDocument == nil)
        #expect(parse(fenced([start, node.replacingOccurrences(of: "\"duration\":2", with: "\"duration\":0"), done])).completedDocument == nil)
    }

    @Test func meshBudgetCountsAllObjects() throws {
        let start = #"{"op":"scene","kind":"scene3d","title":"Budget"}"#
        let vertices = Array(repeating: [0.0, 0.0, 0.0], count: 1_000)
        let nodes = try (0..<5).map { index in
            let value: [String: Any] = ["op": "node", "id": "m\(index)", "shape": "mesh", "position": [0, 0, 0],
                "size": [1, 1, 1], "vertices": vertices, "triangles": [0, 1, 2]]
            return String(decoding: try JSONSerialization.data(withJSONObject: value), as: UTF8.self)
        }
        let stream = parse(fenced([start] + nodes + [done]))
        #expect(stream.preview?.nodes.count == 4)
        #expect(stream.completedDocument == nil)
    }

    @Test func edgeAndTextBudgetsAreEnforced() {
        let edges = (0..<129).map { edge.replacingOccurrences(of: "\"id\":\"ab\"", with: "\"id\":\"e\($0)\"") }
        let oversized = parse(fenced([scene, a, b] + edges + [done]))
        #expect(oversized.preview?.edges.count == 128)
        #expect(oversized.completedDocument == nil)
        let longLabel = a.replacingOccurrences(of: "Input", with: String(repeating: "x", count: 161))
        #expect(parse(fenced([scene, longLabel, done])).preview?.nodes.isEmpty == true)
    }

    @Test func savedDocumentsMustPassSameValidation() throws {
        let document = try #require(parse(fenced([scene, a, b, edge, done])).completedDocument)
        let data = try JSONEncoder().encode(document)
        #expect(try JSONDecoder().decode(VisualDocument.self, from: data).validated() == document)
        let invalid = VisualDocument(kind: .scene3d, title: "Invalid", nodes: [
            VisualNode(id: "invalid", shape: .box, position: VisualVector(x: .infinity, y: 0), size: .one)
        ])
        #expect(throws: VisualValidationError.self) { try invalid.validated() }
        let future = VisualDocument(version: 2, kind: .diagram, title: "Future")
        #expect(throws: VisualValidationError.self) { try future.validated() }
    }

    private func parse(_ text: String) -> VisualStream {
        var stream = VisualStream()
        stream.replace(text: text, itemID: "one")
        return stream
    }
}
