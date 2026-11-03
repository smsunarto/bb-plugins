import Testing
@testable import ClickyCore

@Test func completedReplyWaitsForAuthoritativeIdleStatus() {
    let stillActive = RequestPhase.running.reconciled(remoteStatus: "active", needsApproval: false, queued: false, observedRoot: true, completionStatus: "completed")
    #expect(stillActive == .running)
    #expect(stillActive.busy)
    let idle = stillActive.reconciled(remoteStatus: "idle", needsApproval: false, queued: false, observedRoot: true, completionStatus: "completed")
    #expect(idle == .ready)
    #expect(!idle.busy)
}

@Test func stoppedRootWithoutCompletionUnblocksComposer() {
    let phase = RequestPhase.running.reconciled(remoteStatus: "idle", needsApproval: false, queued: false, observedRoot: true, completionStatus: nil)
    #expect(phase == .failed)
    #expect(!phase.busy)
}

@Test(arguments: ["idle", "active", "error"])
func uncertainDeliveryCannotBeRetriedFromThreadStatusAlone(status: String) {
    let phase = RequestPhase.deliveryUnknown.reconciled(remoteStatus: status, needsApproval: false, queued: false, observedRoot: false, completionStatus: "completed")
    #expect(phase == .deliveryUnknown)
    #expect(phase.busy)
}

@Test func uncertainDeliveryRecoversFromMatchingRootCompletion() {
    let pending = RequestPhase.deliveryUnknown.reconciled(remoteStatus: "idle", needsApproval: false, queued: false, observedRoot: true, completionStatus: nil)
    #expect(pending == .deliveryUnknown)
    let recovered = pending.reconciled(remoteStatus: "idle", needsApproval: false, queued: false, observedRoot: true, completionStatus: "completed")
    #expect(recovered == .ready)
}

@Test func newApprovalAndQueuedWorkOverrideOldCompletion() {
    #expect(RequestPhase.ready.reconciled(remoteStatus: "idle", needsApproval: true, queued: false, observedRoot: true, completionStatus: "completed") == .needsApproval)
    #expect(RequestPhase.ready.reconciled(remoteStatus: "idle", needsApproval: false, queued: true, observedRoot: true, completionStatus: "completed") == .running)
}

@Test func fastPollingIsReservedForForegroundReplies() {
    for phase in [RequestPhase.running, .sending] {
        #expect(RequestPolling.isFast(phase: phase, foreground: true, isJob: false))
        #expect(!RequestPolling.isFast(phase: phase, foreground: false, isJob: false))
        #expect(!RequestPolling.isFast(phase: phase, foreground: true, isJob: true))
    }
    for phase in [RequestPhase.ready, .needsApproval, .deliveryUnknown, .failed] {
        #expect(!RequestPolling.isFast(phase: phase, foreground: true, isJob: false))
    }
}

@Test func statusReconciliationHasABoundedCadenceAndTerminalBypass() {
    #expect(!RequestPolling.statusDue(elapsed: 0.25))
    #expect(!RequestPolling.statusDue(elapsed: 1.99))
    #expect(RequestPolling.statusDue(elapsed: 2))
    #expect(RequestPolling.statusDue(elapsed: 0.25, becameTerminal: true))
    #expect(RequestPolling.fastInterval < RequestPolling.checkpointInterval)
    #expect(RequestPolling.checkpointInterval < RequestPolling.statusInterval)
}
