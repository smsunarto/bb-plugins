import AppKit
import ApplicationServices
import ClickyCore

@MainActor struct InitialDesktopContext {
    var context: DesktopContext
    var capture: CapturedScreen?
}

extension DesktopServices {
    var accessibilityAllowed: Bool { AXIsProcessTrusted() }
    var screenCaptureAllowed: Bool { CGPreflightScreenCaptureAccess() }
    func requestAccessibility() {
        _ = AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary)
    }
    func requestScreenCapture() { _ = CGRequestScreenCaptureAccess() }

    func initialContext(manual: CapturedScreen?) async -> InitialDesktopContext {
        rememberContextApplication(NSWorkspace.shared.frontmostApplication)
        let target = contextApplication
        var context = DesktopContext(application: target?.name ?? "Unknown app", bundleID: target?.bundleID, accessibility: .unavailable)
        if let target {
            context = await boundedContextWait(timeout: .milliseconds(550), operation: { await AccessibilityContext.read(target) }, discard: { _ in })
                ?? DesktopContext(application: target.name, bundleID: target.bundleID, accessibility: .timedOut)
        }
        var displayID = context.displayID
        if displayID == nil, let target {
            let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
            if let row = windows.first(where: { ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == target.pid && ($0[kCGWindowLayer as String] as? Int) == 0 }),
               let raw = row[kCGWindowBounds as String] as? NSDictionary,
               let frame = CGRect(dictionaryRepresentation: raw) {
                displayID = NSScreen.screens.compactMap { ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value }
                    .max(by: { area(frame.intersection(CGDisplayBounds($0))) < area(frame.intersection(CGDisplayBounds($1))) })
            }
        }
        var capture = manual
        if capture == nil {
            if !screenCaptureAllowed { context.screenshot = .permissionDenied }
            else {
                let result = await boundedContextWait(timeout: .milliseconds(1500), operation: {
                    do { return CaptureAttempt(capture: try await self.captureScreen(displayID: displayID, requestPermission: false)) }
                    catch { return CaptureAttempt(capture: nil) }
                }, discard: { result in if let capture = result.capture { self.discardCapture(capture) } })
                capture = result?.capture
                context.screenshot = result == nil ? .timedOut : .unavailable
            }
        }
        if let capture {
            let bounds = ContextRect(CGDisplayBounds(capture.displayID))
            if let windowBounds = context.windowBounds, let bounds, !windowBounds.intersects(bounds) {
                context.nodes = []; context.accessibility = .displayMismatch
            }
            context.screenshot = .available; context.screenshotAt = capture.capturedAt
            context.displayID = capture.displayID; context.displayBounds = bounds
            context.imageWidth = Int(capture.image.size.width); context.imageHeight = Int(capture.image.size.height)
            if manual == nil, let bounds {
                for i in context.nodes.indices { context.nodes[i].imageBounds = context.nodes[i].bounds.normalized(to: bounds) }
            }
        }
        return InitialDesktopContext(context: context, capture: capture)
    }
}

@MainActor private struct CaptureAttempt: Sendable { let capture: CapturedScreen? }

/// Cancelling an uncooperative platform call must not delay Send. Only the first
/// result is consumed; any later screenshot is discarded by its owning service.
@MainActor func boundedContextWait<T: Sendable>(timeout: Duration, operation: @escaping @MainActor @Sendable () async -> T,
                                             discard: @escaping @MainActor @Sendable (T) -> Void) async -> T? {
    let (results, continuation) = AsyncStream<T>.makeStream(bufferingPolicy: .bufferingOldest(1))
    let worker = Task {
        let result = await operation()
        switch continuation.yield(result) {
        case .terminated, .dropped: discard(result)
        case .enqueued: break
        @unknown default: discard(result)
        }
        continuation.finish()
    }
    let timer = Task {
        try? await Task.sleep(for: timeout)
        if !Task.isCancelled { continuation.finish() }
    }
    defer { worker.cancel(); timer.cancel(); continuation.finish() }
    for await result in results { if Task.isCancelled { discard(result); return nil }; return result }
    return nil
}

private func area(_ frame: CGRect) -> CGFloat { frame.isNull ? 0 : frame.width * frame.height }
