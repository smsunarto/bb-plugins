public enum ConversationPhase: String, Codable, Sendable {
    case ready, sending, running, needsApproval, failed, deliveryUnknown

    public var busy: Bool {
        self == .sending || self == .running || self == .needsApproval || self == .deliveryUnknown
    }

    /// Reconcile the requested root turn with BB's current activity. An idle row
    /// alone cannot prove that an uncertain request was accepted or completed.
    public func reconciled(
        remoteStatus: String,
        needsApproval: Bool,
        queued: Bool,
        observedRoot: Bool,
        completionStatus: String?
    ) -> Self {
        if self == .deliveryUnknown && !(observedRoot && completionStatus != nil) {
            return .deliveryUnknown
        }
        if needsApproval { return .needsApproval }
        if remoteStatus == "error" { return .failed }
        if queued || ["active", "starting", "pending", "stopping", "provisioning", "waiting-for-host"].contains(remoteStatus) {
            return .running
        }
        if remoteStatus == "idle", observedRoot {
            return completionStatus == "completed" ? .ready : .failed
        }
        return self
    }
}
