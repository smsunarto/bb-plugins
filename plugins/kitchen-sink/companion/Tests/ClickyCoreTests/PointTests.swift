import Foundation
import Testing
@testable import ClickyCore

struct PointTests {
    @Test func validMarkersBecomeReadOnlyPoints() {
        let parsed = ScreenPoint.parse(in: "Click Save. [POINT:250,750:Save] Then close. [POINT:1000,0:Close]")
        #expect(parsed.text == "Click Save.  Then close.")
        #expect(parsed.points.map(\.label) == ["Save", "Close"])
        #expect(parsed.points.first?.x == 250)
    }

    @Test(arguments: ["[POINT:1001,2:Outside]", "[POINT:-1,2:Negative]", "[POINT:nan,2:NaN]", "[POINT:1,2: ]", "[POINT:1,2:line\nbreak]"])
    func malformedMarkersCannotCreateOverlays(marker: String) {
        let parsed = ScreenPoint.parse(in: marker)
        #expect(parsed.points.isEmpty)
        #expect(parsed.text == marker)
    }

    @Test func screenMappingSupportsScreensLeftAndAboveMainDisplay() throws {
        let point = try #require(ScreenPoint(x: 250, y: 750, label: "Target"))
        let position = point.position(width: 1920, height: 1080, originX: -1920, originY: 1080)
        #expect(position.x == -1440)
        #expect(position.y == 1350)
    }

    @Test func markerCountIsBounded() {
        let parsed = ScreenPoint.parse(in: (1...20).map { "[POINT:1,2:Point \($0)]" }.joined())
        #expect(parsed.points.count == 8)
        #expect(parsed.points.first?.label == "Point 1")
        #expect(parsed.points.last?.label == "Point 8")
    }
}
