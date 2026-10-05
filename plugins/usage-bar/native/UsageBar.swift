// Menu bar helper for the usage-bar bb plugin.
//
// The plugin's server spawns this process and owns its lifetime. It reads one JSON
// message per line on stdin (`snapshot`, `refreshing`) and writes one per line on
// stdout (`menuOpened`, `refresh`, `openBb`, `quit`). It exits when stdin closes,
// so it never outlives bb.
//
// The look follows CodexBar (https://github.com/steipete/CodexBar, MIT): one status
// item per provider with its brand mark and the percent left, and a 310 pt menu of
// stacked account cards. Sizes, colors, and text formats are ported from its
// MenuCardView, UsageProgressBar, UsageFormatter, and UsagePace.

import AppKit
import SwiftUI

// MARK: - Wire model (plugins/usage-bar/src/server/lib/pool.ts)

struct Snapshot: Decodable {
    let providers: [Provider]
    let error: String?
}

struct Provider: Decodable {
    let id: String
    let name: String
    let accounts: [Account]
}

struct Account: Decodable {
    let id: String
    let identity: String
    let plan: String?
    let status: String
    let current: Bool
    let lastUsedAt: Double?
    let observedAt: Double?
    let heldUntil: Double?
    let error: String?
    let inFlight: Int
    let windows: [UsageWindow]
    let resetCredits: ResetCredits?
    let extraUsage: ExtraUsage?
    let resetNotice: String?
    let webResetCredits: WebResetCredits?

    var disabled: Bool { status == "disabled" }
}

struct WebResetCredits: Decodable {
    let count: Int
    let expiry: String?
    let freshUntil: Double

    func isFresh(at now: Date) -> Bool {
        count > 0 && count <= 50 && freshUntil > now.timeIntervalSince1970 * 1000
    }
}

struct ResetCredits: Decodable {
    /// Epoch ms, soonest first; nil never expires.
    let expiries: [Double?]

    func available(at now: Date) -> [Double?] {
        expiries.filter { expiry in expiry.map { date($0) != nil && $0 > now.timeIntervalSince1970 * 1000 } ?? true }
    }
}

/// `balance`: Codex prepaid credits. `spend`: Claude spend against a monthly cap.
struct ExtraUsage: Decodable {
    let kind: String
    let balance: Double?
    let used: Double?
    let limit: Double?
    let currency: String?
}

struct UsageWindow: Decodable {
    let label: String
    let usedPercent: Double
    let resetAt: Double?
    let windowMinutes: Int?
    /// Set on a per-model weekly limit. Null on the shared limits.
    let model: String?

    var resetDate: Date? { date(resetAt) }

    /// The pool keeps a window's last reading until its next read, so a window whose
    /// reset has passed is shown as the fresh window it now is.
    func remaining(at now: Date) -> Double {
        if let reset = resetDate, reset <= now { return 100 }
        return max(0, min(100, 100 - usedPercent))
    }
}

private struct Envelope: Decodable {
    let type: String
    let value: Bool?
}

func date(_ milliseconds: Double?) -> Date? {
    guard let milliseconds, milliseconds.isFinite, abs(milliseconds) <= 8.64e15 else { return nil }
    return Date(timeIntervalSince1970: milliseconds / 1000)
}

// MARK: - Store

final class Store: ObservableObject {
    @Published var snapshot: Snapshot?
    @Published var refreshing = false
    @Published var now = Date()

    func provider(_ id: String) -> Provider? {
        snapshot?.providers.first { $0.id == id }
    }

    func account(provider: String, id: String) -> (Provider, Account)? {
        guard let provider = self.provider(provider),
              let account = provider.accounts.first(where: { $0.id == id })
        else { return nil }
        return (provider, account)
    }
}

enum Wire {
    static func send(_ type: String) {
        FileHandle.standardOutput.write(Data("{\"type\":\"\(type)\"}\n".utf8))
    }
}

// MARK: - Formatting (CodexBarCore/UsageFormatter.swift)

enum Format {
    static func percent(_ value: Double) -> String {
        if value > 0, value < 1 { return "<1%" }
        return "\(Int(value.rounded()))%"
    }

    /// "in 3h 12m", "in 2d 13h", or "now". Minutes round up so a reset never reads early.
    static func countdown(to date: Date, now: Date) -> String {
        let seconds = date.timeIntervalSince(now)
        guard seconds.isFinite, abs(seconds) <= 8.64e12 else { return "unknown" }
        if seconds <= 0 { return "now" }
        let totalMinutes = max(1, Int(ceil(seconds / 60)))
        let days = totalMinutes / 1440
        let hours = (totalMinutes % 1440) / 60
        let minutes = totalMinutes % 60
        if days > 0 {
            if hours > 0 { return "in \(days)d \(hours)h" }
            return minutes > 0 ? "in \(days)d \(minutes)m" : "in \(days)d"
        }
        if hours > 0 { return minutes > 0 ? "in \(hours)h \(minutes)m" : "in \(hours)h" }
        return "in \(minutes)m"
    }

    static func resets(_ date: Date, now: Date) -> String {
        let countdown = countdown(to: date, now: now)
        return countdown == "now" ? "Resets now" : "Resets \(countdown)"
    }

    private static let relative: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter
    }()

    static func updated(_ date: Date, now: Date) -> String {
        if now.timeIntervalSince(date) < 60 { return "Updated just now" }
        return "Updated \(relative.localizedString(for: date, relativeTo: now))"
    }

    /// "Expires in 17d 10h", or "Never expires" for a credit without an expiry.
    static func expiry(_ expiry: Double?, now: Date) -> String {
        guard let date = date(expiry) else { return "Never expires" }
        let countdown = countdown(to: date, now: now)
        return countdown == "now" ? "Expires now" : "Expires \(countdown)"
    }

    /// Codex credits are a raw count: "59,713" from 1,000 up, "12.34" below.
    private static func creditFormatter(fractionDigits: Int) -> NumberFormatter {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        formatter.maximumFractionDigits = fractionDigits
        formatter.locale = Locale(identifier: "en_US")
        return formatter
    }

    private static let wholeCredits = creditFormatter(fractionDigits: 0)
    private static let fractionalCredits = creditFormatter(fractionDigits: 2)

    static func credits(_ value: Double) -> String {
        let formatter = abs(value) >= 1000 ? wholeCredits : fractionalCredits
        return formatter.string(from: NSNumber(value: value)) ?? String(value)
    }

    static func money(_ value: Double, currency: String, cents: Bool = true) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.locale = Locale(identifier: "en_US")
        formatter.currencyCode = currency
        if !cents { formatter.maximumFractionDigits = 0 }
        return formatter.string(from: NSNumber(value: value)) ?? String(format: "%.2f", value)
    }

    /// Provider errors often arrive as a raw JSON body. Show its message, not the JSON.
    static func error(_ error: String) -> String {
        guard let match = error.firstMatch(of: #/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/#) else { return error }
        // The capture is still a JSON string body, so decode its escapes.
        let message = (try? JSONDecoder().decode(String.self, from: Data("\"\(match.1)\"".utf8))) ?? String(match.1)
        return message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? error : message
    }
}

// MARK: - Pace (CodexBarCore/UsagePace.swift, CodexBar/UsagePaceText.swift)

struct Pace {
    let expectedUsedPercent: Double
    let deltaPercent: Double
    let text: String

    var onTrack: Bool { abs(deltaPercent) <= 2 }
    var inReserve: Bool { deltaPercent < 0 }

    /// Linear pace through a window of known length: how far usage sits from an even burn.
    static func of(_ window: UsageWindow, now: Date) -> Pace? {
        guard let minutes = window.windowMinutes, minutes > 0, let reset = window.resetDate,
              window.remaining(at: now) > 0 else { return nil }
        let duration = Double(minutes) * 60
        let untilReset = reset.timeIntervalSince(now)
        guard untilReset > 0, untilReset <= duration else { return nil }
        let elapsed = duration - untilReset
        let expected = min(100, max(0, elapsed / duration * 100))
        let actual = min(100, max(0, window.usedPercent))
        if elapsed == 0, actual > 0 { return nil }
        guard expected >= 3 else { return nil }

        let delta = actual - expected
        let rounded = Int(abs(delta).rounded())
        let onPace = abs(delta) <= 2 || rounded == 0
        // Usage below an even burn always lasts until the reset, so reserve needs no runway.
        if !onPace, delta < 0 {
            return Pace(expectedUsedPercent: expected, deltaPercent: delta, text: "\(rounded)% in reserve")
        }

        let left = onPace ? "On pace" : "\(rounded)% in deficit"
        var right = "Lasts until reset"
        if actual > 0 {
            let runway = (100 - actual) / (actual / elapsed)
            if runway < untilReset {
                let eta = Format.countdown(to: now.addingTimeInterval(runway), now: now)
                right = eta == "now" ? "Runs out now" : "Runs out \(eta)"
            }
        }
        return Pace(expectedUsedPercent: expected, deltaPercent: delta, text: "\(left) · \(right)")
    }
}

// MARK: - Menu card views (CodexBar/MenuCardView.swift, UsageMenuCardLayout.swift)

enum Brand {
    static func tint(_ provider: String) -> Color {
        switch provider {
        case "codex": Color(red: 73 / 255, green: 163 / 255, blue: 176 / 255)
        case "claude": Color(red: 204 / 255, green: 124 / 255, blue: 94 / 255)
        default: Color.accentColor
        }
    }
}

let menuWidth: CGFloat = 310

/// Matches the inset of NSMenu's separators and item icons, so cards line up with them.
let cardInset: CGFloat = 16

struct UsageBar: View {
    let remaining: Double
    let tint: Color
    let pace: Pace?

    var body: some View {
        Canvas { context, size in
            let radius = size.height / 2
            let rect = CGRect(origin: .zero, size: size)
            context.fill(
                Path(roundedRect: rect, cornerRadius: radius),
                with: .color(Color(nsColor: .tertiaryLabelColor).opacity(0.22)))

            let shown = remaining.rounded() <= 0 ? 0 : remaining.rounded() >= 100 ? 100 : remaining
            if shown > 0 {
                let fill = CGRect(x: 0, y: 0, width: size.width * shown / 100, height: size.height)
                context.fill(Path(roundedRect: fill, cornerRadius: radius), with: .color(tint))
            }

            // Punch a gap through the bar where an even burn would be, then draw a stripe in it.
            if let pace, !pace.onTrack {
                let x = size.width * (100 - pace.expectedUsedPercent) / 100
                context.blendMode = .destinationOut
                context.fill(Path(CGRect(x: x - 3, y: 0, width: 6, height: size.height)), with: .color(.white.opacity(0.9)))
                context.blendMode = .normal
                context.fill(
                    Path(CGRect(x: x - 1, y: 0, width: 2, height: size.height)),
                    with: .color(pace.inReserve ? .green : .red))
            }
        }
        .frame(height: 6)
        .accessibilityHidden(true)
    }
}

struct UsageRow: View {
    let window: UsageWindow
    let tint: Color
    let now: Date
    /// A disabled account burns nothing, so its pace would be fiction.
    let showsPace: Bool

    var body: some View {
        let remaining = window.remaining(at: now)
        // A full window has not started, so its reset and pace say nothing.
        let started = remaining.rounded() < 100
        let pace = started && showsPace ? Pace.of(window, now: now) : nil
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("\(window.label) \(Format.percent(remaining)) left")
                    .font(.body)
                    .fontWeight(.medium)
                    .lineLimit(1)
                Spacer(minLength: 8)
                if started, let reset = window.resetDate {
                    Text(Format.resets(reset, now: now))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            UsageBar(remaining: remaining, tint: tint, pace: pace)
            if let pace {
                Text(pace.text)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// One line per extra: a medium label on the left, a secondary detail on the right.
struct ExtraRow: View {
    let label: String
    let detail: String?
    var help: String?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(label).font(.body).fontWeight(.medium).lineLimit(1).layoutPriority(1)
            Spacer(minLength: 8)
            if let detail {
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
        }
        .help(help ?? "")
        .accessibilityElement(children: .combine)
    }
}

/// CodexBar's MenuCardView+CodexResetCredits, folded to one line. The tooltip lists every expiry.
struct ResetCreditsRow: View {
    let expiries: [Double?]
    let now: Date

    var body: some View {
        // Soonest first, so a nil first entry means none of them expire.
        let soonest = expiries.first.flatMap { $0 }
        ExtraRow(
            label: expiries.count == 1 ? "1 limit reset" : "\(expiries.count) limit resets",
            detail: soonest.map { expiries.count == 1 ? Format.expiry($0, now: now) : "Next " + Format.expiry($0, now: now).lowercased() },
            help: expiries.enumerated().map { "\($0.offset + 1). \(Format.expiry($0.element, now: now))" }
                .joined(separator: "\n"))
    }
}

struct WebResetCreditsRow: View {
    let credits: WebResetCredits

    var body: some View {
        ExtraRow(
            label: credits.count == 1 ? "1 limit reset" : "\(credits.count) limit resets",
            detail: credits.expiry,
            help: credits.expiry)
    }
}

/// CodexBar's ProviderCostContent. Like every other bar, the spend bar fills with what is left.
struct ExtraUsageRow: View {
    let usage: ExtraUsage
    let tint: Color

    var body: some View {
        if usage.kind == "spend", let used = usage.used, let limit = usage.limit, limit > 0 {
            let currency = usage.currency ?? "USD"
            let left = max(0, limit - used)
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text("Extra usage \(Format.money(left, currency: currency)) left")
                        .font(.body)
                        .fontWeight(.medium)
                        .lineLimit(1)
                        .layoutPriority(1)
                    Spacer(minLength: 8)
                    Text("of \(Format.money(limit, currency: currency, cents: false)) a month")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                UsageBar(remaining: min(100, left / limit * 100), tint: tint, pace: nil)
            }
            .accessibilityElement(children: .combine)
        } else if let balance = usage.balance {
            // The server sends only positive balances; keep a sliver from reading "0".
            let amount = balance < 0.005 ? "<0.01" : Format.credits(balance)
            ExtraRow(label: "Extra usage", detail: amount == "1" ? "1 credit" : "\(amount) credits")
        }
    }
}

struct AccountCard: View {
    @ObservedObject var store: Store
    let providerId: String
    let accountId: String

    var body: some View {
        if let match = store.account(provider: providerId, id: accountId) {
            card(provider: match.0, account: match.1)
        }
    }

    private func subtitle(_ account: Account) -> (String, Bool) {
        if let error = account.error { return (Format.error(error), true) }
        if store.refreshing, !account.disabled { return ("Refreshing…", false) }
        if let observed = date(account.observedAt) {
            return (Format.updated(observed, now: store.now), false)
        }
        return ("No usage reading yet", false)
    }

    /// The pool's routing state. Problems read orange; the account in use reads in the accent color.
    private func routing(_ account: Account) -> (String, Color)? {
        var parts: [String] = []
        if account.inFlight > 0 {
            parts.append("In use · \(account.inFlight) in flight")
        } else if account.current, account.lastUsedAt != nil {
            parts.append("Last used")
        }
        switch account.status {
        case "held":
            parts.append(date(account.heldUntil).map { "Held · back \(Format.countdown(to: $0, now: store.now))" } ?? "Held")
            return (parts.joined(separator: " · "), Color(nsColor: .systemOrange))
        case "exhausted":
            parts.append("Exhausted")
            return (parts.joined(separator: " · "), Color(nsColor: .systemOrange))
        case "disabled":
            return ("Disabled", .secondary)
        default:
            return parts.isEmpty ? nil : (parts.joined(separator: " · "), Color(nsColor: .controlAccentColor))
        }
    }

    private func card(provider: Provider, account: Account) -> some View {
        let (subtitle, isError) = subtitle(account)
        let routing = routing(account)
        let tint = Brand.tint(provider.id)
        let resets = account.resetCredits?.available(at: store.now) ?? []
        let webResets = resets.isEmpty && account.webResetCredits?.isFresh(at: store.now) == true ? account.webResetCredits : nil
        let hasExtras = !resets.isEmpty || webResets != nil || account.extraUsage != nil
        return VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text(account.identity)
                        .font(.headline)
                        .fontWeight(.semibold)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: 8)
                    if let plan = account.plan {
                        Text(plan).font(.subheadline).foregroundStyle(.secondary).lineLimit(1).layoutPriority(1)
                    }
                }
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text(subtitle)
                        .font(.footnote)
                        .foregroundStyle(isError ? Color(nsColor: .systemRed) : .secondary)
                        .lineLimit(isError ? 4 : 1)
                        .help(isError ? account.error ?? "" : "")
                    Spacer(minLength: 8)
                    if let routing {
                        Text(routing.0)
                            .font(.footnote)
                            .fontWeight(.semibold)
                            .foregroundStyle(routing.1)
                            .lineLimit(1)
                            .layoutPriority(1)
                    }
                }
            }
            .accessibilityElement(children: .combine)
            if !account.windows.isEmpty {
                Divider().padding(.top, 6).padding(.bottom, 12)
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(Array(account.windows.enumerated()), id: \.offset) { _, window in
                        UsageRow(window: window, tint: tint, now: store.now, showsPace: !account.disabled)
                    }
                }
            }
            if hasExtras {
                Divider().padding(.vertical, 12)
                VStack(alignment: .leading, spacing: 8) {
                    if !resets.isEmpty { ResetCreditsRow(expiries: resets, now: store.now) }
                    if let webResets { WebResetCreditsRow(credits: webResets) }
                    if let extra = account.extraUsage { ExtraUsageRow(usage: extra, tint: tint) }
                }
            }
        }
        .padding(.horizontal, cardInset)
        .padding(.top, 8)
        .padding(.bottom, 10)
        .frame(width: menuWidth, alignment: .leading)
        .opacity(account.disabled ? 0.5 : 1)
    }
}

/// Shown above the cards when the last read failed and the menu shows older data.
struct ErrorBanner: View {
    @ObservedObject var store: Store

    var body: some View {
        if let error = store.snapshot?.error {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(Color(nsColor: .systemOrange))
                    .accessibilityHidden(true)
                Text(error)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .font(.footnote)
            .padding(.horizontal, cardInset)
            .padding(.vertical, 6)
            .frame(width: menuWidth, alignment: .leading)
        }
    }
}

// MARK: - Status items

/// NSMenu sizes a custom-view row from its intrinsic height, and an open menu resizes
/// with every change to it. So a row reports its measured height here (CodexBar's
/// MenuHostingView) and changes it only when the content needs a new one: a passing
/// smaller size would clamp the scroll position of a menu taller than the screen.
final class MenuRowHost: NSHostingView<AnyView> {
    private var measured: CGFloat?

    convenience init(_ view: some View) {
        self.init(rootView: AnyView(view))
        fit()
    }

    required init(rootView: AnyView) { super.init(rootView: rootView) }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override var intrinsicContentSize: NSSize {
        guard let measured else { return super.intrinsicContentSize }
        return NSSize(width: menuWidth, height: measured)
    }

    /// Apply SwiftUI's pending state, then measure without the cached height, which
    /// would otherwise feed back into fittingSize.
    func fit() {
        layoutSubtreeIfNeeded()
        let previous = measured
        measured = nil
        let height = fittingSize.height
        measured = height
        guard previous != height else { return }
        setFrameSize(NSSize(width: menuWidth, height: height))
        invalidateIntrinsicContentSize()
        superview?.layoutSubtreeIfNeeded()
    }
}

final class ProviderItem: NSObject, NSMenuDelegate {
    let providerId: String
    let statusItem: NSStatusItem
    let store: Store
    private let logo: NSImage?
    private var open = false
    /// What the open menu was built from. A change in shape rebuilds it; otherwise rows refit.
    private var shape: [String] = []
    private var hosts: [MenuRowHost] = []

    init(providerId: String, store: Store, nativeDir: String) {
        self.providerId = providerId
        self.store = store
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.autosaveName = "bb-usage-bar-\(providerId)"
        logo = NSImage(contentsOfFile: "\(nativeDir)/\(providerId).svg")
        logo?.size = NSSize(width: 16, height: 16)
        logo?.isTemplate = true
        super.init()
        statusItem.button?.image = logo
        statusItem.button?.imagePosition = .imageLeft
        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu
    }

    func remove() { NSStatusBar.system.removeStatusItem(statusItem) }

    /// The current account's lowest percent left across its shared limits, like CodexBar's
    /// most-constrained metric: one number has to carry the limit that binds first. A
    /// per-model limit only diverts that model's requests, so it counts only when the
    /// account reports nothing else.
    func render() {
        guard let button = statusItem.button else { return }
        let now = store.now
        let provider = store.provider(providerId)
        let account = provider?.accounts.first { $0.current } ?? provider?.accounts.first
        let windows = account?.windows ?? []
        let shared = windows.filter { $0.model == nil }
        let window = (shared.isEmpty ? windows : shared).min { $0.remaining(at: now) < $1.remaining(at: now) }
        let title = window.map { Format.percent($0.remaining(at: now)) } ?? "–"
        button.attributedTitle = NSAttributedString(
            string: title,
            attributes: [.font: NSFont.monospacedDigitSystemFont(ofSize: NSFont.systemFontSize, weight: .regular)])
        let stale = store.snapshot?.error != nil || account?.error != nil
        button.appearsDisabled = stale
        let name = provider?.name ?? providerId
        let detail = window.map { "\($0.label) \(title) left" } ?? "No usage reading"
        button.toolTip = [account.map { "\(name) · \($0.identity)" } ?? name, detail]
            .joined(separator: "\n")
        button.setAccessibilityLabel("\(name), \(detail)\(stale ? ", not up to date" : "")")
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        Wire.send("menuOpened")
        store.now = Date()
        build(menu)
    }

    func menuWillOpen(_ menu: NSMenu) { open = true }

    func menuDidClose(_ menu: NSMenu) { open = false }

    /// Keep an open menu in step with new snapshots and the clock.
    func update() {
        guard open, let menu = statusItem.menu else { return }
        if shape(store.provider(providerId)) != shape {
            build(menu)
        } else {
            hosts.forEach { $0.fit() }
        }
    }

    private func notice(_ provider: Provider) -> String? {
        provider.accounts.first { account in
            account.resetNotice != nil && !account.disabled && account.webResetCredits?.isFresh(at: store.now) != true
        }?.resetNotice
    }

    private func shape(_ provider: Provider?) -> [String] {
        guard let provider else { return [] }
        return provider.accounts.map(\.id) + [store.snapshot?.error == nil ? "" : "error", notice(provider) ?? ""]
    }

    private func build(_ menu: NSMenu) {
        menu.removeAllItems()
        hosts = []
        let provider = store.provider(providerId)
        shape = shape(provider)
        guard let provider else { return }

        if store.snapshot?.error != nil {
            menu.addItem(row(ErrorBanner(store: store)))
            menu.addItem(.separator())
        }
        for (index, account) in provider.accounts.enumerated() {
            if index > 0 { menu.addItem(.separator()) }
            menu.addItem(row(AccountCard(store: store, providerId: providerId, accountId: account.id)))
        }

        menu.addItem(.separator())
        if let notice = notice(provider) {
            let item = action(notice, symbol: "arrow.up.forward.app", key: "", selector: #selector(openClaudeUsage))
            item.toolTip = "Claude Code does not expose full-reset inventory. Check the signed-in account in Claude."
            menu.addItem(item)
        }
        menu.addItem(action("Refresh", symbol: "arrow.clockwise", key: "r", selector: #selector(refresh)))
        menu.addItem(action("Open bb", symbol: "macwindow", key: "o", selector: #selector(openBb)))
        menu.addItem(action("Quit Usage Bar", symbol: "xmark.rectangle", key: "q", selector: #selector(quit)))
    }

    private func row(_ view: some View) -> NSMenuItem {
        let host = MenuRowHost(view)
        hosts.append(host)
        let item = NSMenuItem()
        // An empty title keeps macOS from painting a placeholder title behind the view.
        item.title = ""
        item.view = host
        return item
    }

    private func action(_ title: String, symbol: String, key: String, selector: Selector) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: selector, keyEquivalent: key)
        item.target = self
        item.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
        return item
    }

    @objc private func openClaudeUsage() {
        NSWorkspace.shared.open(URL(string: "https://claude.ai/settings/usage")!)
    }

    @objc private func refresh() {
        store.refreshing = true
        Wire.send("refresh")
    }

    @objc private func openBb() { Wire.send("openBb") }

    @objc private func quit() {
        Wire.send("quit")
        NSApp.terminate(nil)
    }
}

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate {
    let store = Store()
    let nativeDir: String
    var items: [String: ProviderItem] = [:]
    var clock: Timer?

    init(nativeDir: String) { self.nativeDir = nativeDir }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Countdowns tick while a menu is open, so run in the common modes. They round
        // up to the minute, so a late tick never shows an early value.
        let timer = Timer(timeInterval: 15, repeats: true) { [weak self] _ in self?.tick() }
        timer.tolerance = 1.5
        RunLoop.main.add(timer, forMode: .common)
        clock = timer

        Thread.detachNewThread { [weak self] in
            while let line = readLine() {
                guard let data = line.data(using: .utf8) else { continue }
                DispatchQueue.main.async { self?.receive(data) }
            }
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
    }

    private func tick() {
        store.now = Date()
        for item in items.values {
            item.render()
            item.update()
        }
    }

    private func receive(_ data: Data) {
        let decoder = JSONDecoder()
        guard let envelope = try? decoder.decode(Envelope.self, from: data) else { return }
        switch envelope.type {
        case "snapshot":
            let snapshot: Snapshot
            do {
                snapshot = try decoder.decode(Snapshot.self, from: data)
            } catch {
                FileHandle.standardError.write(Data("usage-bar: undecodable snapshot: \(error)\n".utf8))
                return
            }
            store.snapshot = snapshot
            sync(snapshot)
        case "refreshing":
            store.refreshing = envelope.value ?? false
        default:
            break
        }
    }

    /// One status item per provider in the pool, in the pool's provider order.
    private func sync(_ snapshot: Snapshot) {
        let ids = Set(snapshot.providers.map(\.id))
        for (id, item) in items where !ids.contains(id) {
            item.remove()
            items[id] = nil
        }
        // Status items are laid out right to left, so add the last provider first.
        for provider in snapshot.providers.reversed() where items[provider.id] == nil {
            items[provider.id] = ProviderItem(providerId: provider.id, store: store, nativeDir: nativeDir)
        }
        for item in items.values {
            item.render()
            item.update()
        }
    }
}

@main
enum UsageBarApp {
    static func main() {
        guard CommandLine.arguments.count > 1 else {
            FileHandle.standardError.write(Data("usage: UsageBar <native-dir> | UsageBar --check-snapshot\n".utf8))
            exit(64)
        }
        // test/wire.test.ts: decode each stdin line as the app would, and fail on the first mismatch.
        if CommandLine.arguments[1] == "--check-snapshot" {
            while let line = readLine() {
                do {
                    _ = try JSONDecoder().decode(Snapshot.self, from: Data(line.utf8))
                } catch {
                    FileHandle.standardError.write(Data("\(error)\n".utf8))
                    exit(1)
                }
            }
            exit(0)
        }
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let delegate = AppDelegate(nativeDir: CommandLine.arguments[1])
        app.delegate = delegate
        app.run()
    }
}
