// Menu bar helper for the pool-bar bb plugin.
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

// MARK: - Wire model (plugins/pool-bar/src/server/lib/pool.ts)

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
    let priority: Int
    let status: String
    let current: Bool
    let observedAt: Double?
    let heldUntil: Double?
    let error: String?
    let inFlight: Int
    let windows: [UsageWindow]
    let resetCredits: ResetCredits?
    let extraUsage: ExtraUsage?
    let resetNotice: String?
}

struct ResetCredits: Decodable {
    /// Epoch ms, soonest first; nil never expires.
    let expiries: [Double?]

    func available(at now: Date) -> [Double?] {
        expiries.filter { expiry in expiry.map { $0 > now.timeIntervalSince1970 * 1000 } ?? true }
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

    var remainingPercent: Double { max(0, min(100, 100 - usedPercent)) }
    var resetDate: Date? { resetAt.map { Date(timeIntervalSince1970: $0 / 1000) } }
}

private struct Envelope: Decodable {
    let type: String
    let value: Bool?
}

func date(_ milliseconds: Double?) -> Date? {
    milliseconds.map { Date(timeIntervalSince1970: $0 / 1000) }
}

// MARK: - Store

final class Store: ObservableObject {
    @Published var snapshot: Snapshot?
    @Published var refreshing = false
    @Published var now = Date()

    func account(provider: String, id: String) -> (Provider, Account)? {
        guard let provider = snapshot?.providers.first(where: { $0.id == provider }),
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

    private static let clock: DateFormatter = {
        let formatter = DateFormatter()
        formatter.timeStyle = .short
        formatter.dateStyle = .none
        return formatter
    }()

    static func updated(_ date: Date, now: Date) -> String {
        let age = now.timeIntervalSince(date)
        if age < 60 { return "Updated just now" }
        if age < 86_400 { return "Updated \(relative.localizedString(for: date, relativeTo: now))" }
        return "Updated \(clock.string(from: date))"
    }

    static func time(_ date: Date) -> String { clock.string(from: date) }

    /// "3d 19h · 21d 17h · 28d 15h", up to four credits, then "+N".
    static func expiries(_ expiries: [Double?], now: Date) -> String {
        let items = expiries.prefix(4).map { expiry -> String in
            guard let date = date(expiry) else { return "No expiry" }
            let countdown = countdown(to: date, now: now)
            return countdown.hasPrefix("in ") ? String(countdown.dropFirst(3)) : countdown
        }
        let more = expiries.count > 4 ? ["+\(expiries.count - 4)"] : []
        return (items + more).joined(separator: " · ")
    }

    /// Codex credits are a raw count; POSIX formatting keeps them as "62500".
    private static let credits: NumberFormatter = {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        formatter.maximumFractionDigits = 2
        formatter.locale = Locale(identifier: "en_US_POSIX")
        return formatter
    }()

    static func credits(_ value: Double) -> String {
        credits.string(from: NSNumber(value: value)) ?? String(value)
    }

    static func money(_ value: Double, currency: String) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.locale = Locale(identifier: "en_US")
        formatter.currencyCode = currency
        return formatter.string(from: NSNumber(value: value)) ?? String(format: "%.2f", value)
    }
}

// MARK: - Pace (CodexBarCore/UsagePace.swift, CodexBar/UsagePaceText.swift)

struct Pace {
    let expectedUsedPercent: Double
    let deltaPercent: Double
    let text: String

    var onTrack: Bool { abs(deltaPercent) <= 2 }
    var inReserve: Bool { deltaPercent < 0 }

    /// Linear pace through a weekly window: how far usage sits from an even burn.
    static func weekly(_ window: UsageWindow, now: Date) -> Pace? {
        guard let minutes = window.windowMinutes, minutes == 10080, let reset = window.resetDate,
              window.remainingPercent > 0 else { return nil }
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
        let left = abs(delta) <= 2 || rounded == 0
            ? "On pace"
            : delta > 0 ? "\(rounded)% in deficit" : "\(rounded)% in reserve"

        var right: String?
        if actual == 0 {
            right = "Lasts until reset"
        } else {
            let runway = (100 - actual) / (actual / elapsed)
            if runway >= untilReset {
                right = "Lasts until reset"
            } else {
                let eta = Format.countdown(to: now.addingTimeInterval(runway), now: now)
                right = eta == "now" ? "Runs out now" : "Runs out \(eta)"
            }
        }
        let text = right.map { "\(left) · \($0)" } ?? left
        return Pace(expectedUsedPercent: expected, deltaPercent: delta, text: text)
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

/// Quota-warning thresholds, in percent left, drawn as ticks on every bar.
let warningMarkers: [Double] = [50, 20]

struct UsageBar: View {
    let remaining: Double
    let tint: Color
    let pace: Pace?
    var markers: [Double] = warningMarkers

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

            // Punch a gap through the bar, then draw a thin stripe in it.
            func notch(at x: CGFloat, gap: CGFloat, stripe: CGFloat, color: Color) {
                context.blendMode = .destinationOut
                context.fill(
                    Path(CGRect(x: x - gap / 2, y: 0, width: gap, height: size.height)),
                    with: .color(.white.opacity(0.9)))
                context.blendMode = .normal
                context.fill(
                    Path(CGRect(x: x - stripe / 2, y: 0, width: stripe, height: size.height)),
                    with: .color(color))
            }
            for marker in markers {
                notch(at: size.width * marker / 100, gap: 5, stripe: 1, color: .primary.opacity(0.68))
            }
            if let pace, !pace.onTrack {
                let x = size.width * (100 - pace.expectedUsedPercent) / 100
                notch(at: x, gap: 6, stripe: 2, color: pace.inReserve ? .green : .red)
            }
        }
        .frame(height: 6)
    }
}

struct UsageRow: View {
    let window: UsageWindow
    let tint: Color
    let now: Date

    var body: some View {
        let pace = Pace.weekly(window, now: now)
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("\(window.label) \(Format.percent(window.remainingPercent)) left")
                    .font(.body)
                    .fontWeight(.medium)
                    .lineLimit(1)
                Spacer(minLength: 8)
                if let reset = window.resetDate {
                    Text(Format.resets(reset, now: now))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            UsageBar(remaining: window.remainingPercent, tint: tint, pace: pace)
            if let pace {
                Text(pace.text)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
    }
}

/// CodexBar's MenuCardView+CodexResetCredits.
struct ResetCreditsRow: View {
    let credits: ResetCredits
    let now: Date

    var body: some View {
        let expiries = credits.available(at: now)
        let count = expiries.count
        VStack(alignment: .leading, spacing: 4) {
            Text("Limit Reset Credits").font(.body).fontWeight(.medium).lineLimit(1)
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("\(count) available")
                    .font(.footnote.weight(.semibold))
                    .lineLimit(1)
                    .layoutPriority(1)
                Spacer(minLength: 8)
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Image(systemName: "clock").font(.caption2)
                    Text(Format.expiries(expiries, now: now))
                        .font(.caption)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }
                .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// CodexBar's ProviderCostContent: an inline balance, or spend against a cap with a bar.
struct ExtraUsageRow: View {
    let usage: ExtraUsage
    let tint: Color

    var body: some View {
        if usage.kind == "spend", let used = usage.used, let limit = usage.limit, limit > 0 {
            let currency = usage.currency ?? "USD"
            let usedPercent = min(100, max(0, used / limit * 100))
            VStack(alignment: .leading, spacing: 6) {
                Text("Extra usage").font(.body).fontWeight(.medium).lineLimit(1)
                UsageBar(remaining: 100 - usedPercent, tint: tint, pace: nil, markers: [])
                HStack(alignment: .firstTextBaseline) {
                    Text("Monthly cap: \(Format.money(used, currency: currency)) / \(Format.money(limit, currency: currency))")
                        .font(.footnote)
                        .lineLimit(1)
                    Spacer()
                    Text("\(Int(usedPercent.rounded()))% used").font(.footnote).foregroundStyle(.secondary)
                }
            }
        } else if let balance = usage.balance {
            HStack(alignment: .firstTextBaseline) {
                Text("Extra usage").font(.body).fontWeight(.medium)
                Spacer()
                Text("Balance: \(Format.credits(balance))").font(.footnote).monospacedDigit().lineLimit(1)
            }
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
        if let error = account.error { return (error, true) }
        if store.refreshing { return ("Refreshing…", false) }
        if let observed = date(account.observedAt) {
            return (Format.updated(observed, now: store.now), false)
        }
        return ("Not fetched yet", false)
    }

    private func card(provider: Provider, account: Account) -> some View {
        let (subtitle, isError) = subtitle(account)
        return VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text(provider.name).font(.headline).fontWeight(.semibold).lineLimit(1)
                    Spacer()
                    Text(account.identity)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text(subtitle)
                        .font(.footnote)
                        .foregroundStyle(isError ? Color(nsColor: .systemRed) : .secondary)
                        .lineLimit(isError ? 4 : 1)
                    Spacer()
                    if let plan = account.plan {
                        Text(plan).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
            }
            let availableResets = account.resetCredits?.available(at: store.now) ?? []
            if !account.windows.isEmpty || !availableResets.isEmpty || account.resetNotice != nil {
                Divider().padding(.top, 6).padding(.bottom, 12)
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(Array(account.windows.enumerated()), id: \.offset) { _, window in
                        UsageRow(window: window, tint: Brand.tint(provider.id), now: store.now)
                    }
                    if let credits = account.resetCredits, !availableResets.isEmpty {
                        if !account.windows.isEmpty { Divider() }
                        ResetCreditsRow(credits: credits, now: store.now)
                    }
                    if let notice = account.resetNotice {
                        Link(notice, destination: URL(string: "https://claude.ai/settings/usage")!)
                            .font(.footnote)
                            .help("Claude Code does not expose full-reset inventory. Check the signed-in account in Claude.")
                    }
                }
            }
            if let extra = account.extraUsage {
                Divider().padding(.vertical, 12)
                ExtraUsageRow(usage: extra, tint: Brand.tint(provider.id))
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 6)
        .padding(.bottom, 10)
        .frame(width: menuWidth, alignment: .leading)
        .opacity(account.status == "disabled" ? 0.5 : 1)
    }
}

// MARK: - Status items

final class ProviderItem: NSObject, NSMenuDelegate {
    let providerId: String
    let statusItem: NSStatusItem
    let store: Store
    private let logo: NSImage?

    init(providerId: String, store: Store, nativeDir: String) {
        self.providerId = providerId
        self.store = store
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.autosaveName = "bb-pool-bar-\(providerId)"
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

    /// The current account's percent left, on the first exhausted window or else the
    /// first window, as CodexBar's "automatic" menu bar metric picks it.
    func render() {
        guard let button = statusItem.button else { return }
        let provider = store.snapshot?.providers.first { $0.id == providerId }
        let account = provider?.accounts.first { $0.current } ?? provider?.accounts.first
        let window = account?.windows.first { $0.remainingPercent <= 0 } ?? account?.windows.first
        let title = window.map { Format.percent($0.remainingPercent) } ?? "–"
        button.attributedTitle = NSAttributedString(
            string: title,
            attributes: [.font: NSFont.monospacedDigitSystemFont(ofSize: NSFont.systemFontSize, weight: .regular)])
        button.appearsDisabled = store.snapshot?.error != nil || account?.error != nil
        button.setAccessibilityLabel("\(provider?.name ?? providerId) usage \(title) left")
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        Wire.send("menuOpened")
        store.now = Date()
        menu.removeAllItems()
        guard let provider = store.snapshot?.providers.first(where: { $0.id == providerId }) else { return }

        if let error = store.snapshot?.error {
            let item = NSMenuItem(title: "Account Pooler unavailable: \(error)", action: nil, keyEquivalent: "")
            item.isEnabled = false
            menu.addItem(item)
            menu.addItem(.separator())
        }

        for (index, account) in provider.accounts.enumerated() {
            if index > 0 { menu.addItem(.separator()) }
            menu.addItem(NSMenuItem.sectionHeader(title: header(account, position: index + 1)))
            let card = NSHostingView(rootView: AccountCard(store: store, providerId: providerId, accountId: account.id))
            card.frame = NSRect(x: 0, y: 0, width: menuWidth, height: card.fittingSize.height)
            let item = NSMenuItem()
            item.view = card
            menu.addItem(item)
        }

        menu.addItem(.separator())
        menu.addItem(action("Refresh", symbol: "arrow.clockwise", key: "r", selector: #selector(refresh)))
        menu.addItem(action("Open bb", symbol: "macwindow", key: "o", selector: #selector(openBb)))
        menu.addItem(action("Quit", symbol: "xmark.rectangle", key: "q", selector: #selector(quit)))
    }

    /// Pool routing state, in the slot CodexBar uses for an account's organization.
    private func header(_ account: Account, position: Int) -> String {
        var parts = ["Account \(position)"]
        if account.inFlight > 0 {
            parts.append("In use · \(account.inFlight) in flight")
        } else if account.current {
            parts.append("Last used")
        }
        switch account.status {
        case "held":
            if let until = date(account.heldUntil) { parts.append("Held until \(Format.time(until))") }
        case "exhausted": parts.append("Exhausted")
        case "disabled": parts.append("Disabled")
        case "error": parts.append("Error")
        default: break
        }
        return parts.joined(separator: " · ")
    }

    private func action(_ title: String, symbol: String, key: String, selector: Selector) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: selector, keyEquivalent: key)
        item.target = self
        item.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
        return item
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
        // Countdowns tick while a menu is open, so run in the common modes.
        let timer = Timer(timeInterval: 15, repeats: true) { [weak self] _ in self?.store.now = Date() }
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

    private func receive(_ data: Data) {
        let decoder = JSONDecoder()
        guard let envelope = try? decoder.decode(Envelope.self, from: data) else { return }
        switch envelope.type {
        case "snapshot":
            guard let snapshot = try? decoder.decode(Snapshot.self, from: data) else {
                FileHandle.standardError.write(Data("pool-bar: undecodable snapshot\n".utf8))
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
        for item in items.values { item.render() }
    }
}

@main
enum PoolBar {
    static func main() {
        guard CommandLine.arguments.count > 1 else {
            FileHandle.standardError.write(Data("usage: PoolBar <native-dir>\n".utf8))
            exit(64)
        }
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let delegate = AppDelegate(nativeDir: CommandLine.arguments[1])
        app.delegate = delegate
        app.run()
    }
}
