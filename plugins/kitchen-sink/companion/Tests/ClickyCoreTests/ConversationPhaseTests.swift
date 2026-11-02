import Testing
@testable import ClickyCore

@Test func completedReplyWaitsForAuthoritativeIdleStatus() {
    let stillActive = ConversationPhase.running.reconciled(remoteStatus: "active", needsApproval: false, queued: false, observedRoot: true, completionStatus: "completed")
    #expect(stillActive == .running)
    #expect(stillActive.busy)
    let idle = stillActive.reconciled(remoteStatus: "idle", needsApproval: false, queued: false, observedRoot: true, completionStatus: "completed")
    #expect(idle == .ready)
    #expect(!idle.busy)
}

@Test func stoppedRootWithoutCompletionUnblocksComposer() {
    let phase = ConversationPhase.running.reconciled(remoteStatus: "idle", needsApproval: false, queued: false, observedRoot: true, completionStatus: nil)
    #expect(phase == .failed)
    #expect(!phase.busy)
}

@Test(arguments: ["idle", "active", "error"])
func uncertainDeliveryCannotBeRetriedFromThreadStatusAlone(status: String) {
    let phase = ConversationPhase.deliveryUnknown.reconciled(remoteStatus: status, needsApproval: false, queued: false, observedRoot: false, completionStatus: "completed")
    #expect(phase == .deliveryUnknown)
    #expect(phase.busy)
}

@Test func uncertainDeliveryRecoversFromMatchingRootCompletion() {
    let pending = ConversationPhase.deliveryUnknown.reconciled(remoteStatus: "idle", needsApproval: false, queued: false, observedRoot: true, completionStatus: nil)
    #expect(pending == .deliveryUnknown)
    let recovered = pending.reconciled(remoteStatus: "idle", needsApproval: false, queued: false, observedRoot: true, completionStatus: "completed")
    #expect(recovered == .ready)
}

@Test func newApprovalAndQueuedWorkOverrideOldCompletion() {
    #expect(ConversationPhase.ready.reconciled(remoteStatus: "idle", needsApproval: true, queued: false, observedRoot: true, completionStatus: "completed") == .needsApproval)
    #expect(ConversationPhase.ready.reconciled(remoteStatus: "idle", needsApproval: false, queued: true, observedRoot: true, completionStatus: "completed") == .running)
}
