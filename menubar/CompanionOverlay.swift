import AppKit
import Foundation
import WebKit

/**
 * 伴随模式的桌面呈现：
 *  - 一个不抢焦点的悬浮窗（右上角），把气泡一张张叠出来；气泡自动淡出，鼠标悬停暂停
 *  - 点气泡 → 弹一个小对话窗（WKWebView 加载 /mini.html?b=<id>），专注于那个话题
 *  - 全部通过本机 HTTP 与主进程通信，不共享内存
 */

struct Bubble {
    var id: String
    var scenario: String
    var topic: String
    var text: String
    var why: String
}

let SCENARIO_EMOJI: [String: String] = ["chat": "💬", "video": "🎬", "work": "💼", "code": "⌨️", "browse": "🌐", "other": "💡"]

final class OverlayController: NSObject {
    private var window: NSWindow?
    private var stack: NSStackView?
    private var visible: [String: NSView] = [:]
    private var miniPanels: [String: NSWindow] = [:]

    private let maxVisible = 3

    private func ensureWindow() {
        if window != nil { return }
        let size = NSSize(width: 320, height: 10)
        let w = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
        w.isOpaque = false
        w.backgroundColor = .clear
        w.hasShadow = false
        w.level = .floating
        w.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        w.ignoresMouseEvents = false
        w.isMovableByWindowBackground = true
        w.animationBehavior = .utilityWindow

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .trailing
        stack.spacing = 8
        stack.edgeInsets = NSEdgeInsets(top: 8, left: 8, bottom: 8, right: 12)
        stack.translatesAutoresizingMaskIntoConstraints = false
        let content = NSView()
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            stack.topAnchor.constraint(equalTo: content.topAnchor),
            stack.bottomAnchor.constraint(equalTo: content.bottomAnchor),
        ])
        w.contentView = content
        window = w
        self.stack = stack
    }

    private func reposition() {
        guard let w = window, let screen = NSScreen.main else { return }
        let frame = screen.visibleFrame
        w.layoutIfNeeded()
        let height = max(10, stack?.fittingSize.height ?? 10)
        let width: CGFloat = 320
        let x = frame.maxX - width - 16
        let y = frame.maxY - height - 16
        w.setFrame(NSRect(x: x, y: y, width: width, height: height), display: true)
    }

    func present(_ bubbles: [Bubble], onOpen: @escaping (Bubble) -> Void, onDismiss: @escaping (Bubble) -> Void) {
        guard !bubbles.isEmpty else { return }
        ensureWindow()
        guard let stack = stack, let w = window else { return }
        for b in bubbles where visible[b.id] == nil {
            let card = BubbleCard(bubble: b)
            card.onOpen = { onOpen(b) }
            card.onDismiss = { onDismiss(b) }
            card.onSelfDismiss = { [weak self] in self?.remove(b.id) }
            stack.addArrangedSubview(card)
            visible[b.id] = card
            // 进场
            card.alphaValue = 0
            card.animator().alphaValue = 1
        }
        // 只留最近 maxVisible 张
        let arranged = stack.arrangedSubviews
        if arranged.count > maxVisible {
            for view in arranged.prefix(arranged.count - maxVisible) {
                stack.removeArrangedSubview(view)
                view.removeFromSuperview()
                if let id = visible.first(where: { $0.value === view })?.key { visible.removeValue(forKey: id) }
            }
        }
        reposition()
        w.orderFrontRegardless()
        w.ignoresMouseEvents = false
    }

    private func remove(_ id: String) {
        guard let view = visible[id], let stack = stack else { return }
        visible.removeValue(forKey: id)
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.18
            view.animator().alphaValue = 0
        } completionHandler: { [weak self] in
            stack.removeArrangedSubview(view)
            view.removeFromSuperview()
            guard let self else { return }
            if self.visible.isEmpty { self.window?.orderOut(nil) } else { self.reposition() }
        }
    }

    /// 点开气泡 → 小对话窗（WKWebView）
    func openMini(for bubble: Bubble, port: String, token: String) {
        if let existing = miniPanels[bubble.id] {
            existing.makeKeyAndOrderFront(nil)
            return
        }
        let panel = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 420, height: 560),
            styleMask: [.titled, .closable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        panel.title = "伴随 · \(bubble.topic)"
        panel.titlebarAppearsTransparent = true
        panel.level = .floating
        panel.isReleasedWhenClosed = false
        let web = WKWebView(frame: panel.contentView?.bounds ?? .zero, configuration: WKWebViewConfiguration())
        web.autoresizingMask = [.width, .height]
        // 小窗内不需要 cookie 之外的任何注入；本机访问免登录时直接可用
        _ = token
        if let url = URL(string: "http://127.0.0.1:\(port)/mini.html?b=\(bubble.id)") {
            web.load(URLRequest(url: url))
        }
        panel.contentView = web
        panel.center()
        panel.makeKeyAndOrderFront(nil)
        miniPanels[bubble.id] = panel
        NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: panel, queue: .main) { [weak self] _ in
            self?.miniPanels.removeValue(forKey: bubble.id)
        }
    }
}

/// 单张气泡：图标 + 一句话 + 悬停显示的按钮；12 秒自动淡出（鼠标停在上面就不走）
final class BubbleCard: NSView {
    var onOpen: (() -> Void)?
    var onDismiss: (() -> Void)?
    var onSelfDismiss: (() -> Void)?
    private var tracking: NSTrackingArea?
    private var hovering = false
    private var timer: Timer?

    init(bubble: Bubble) {
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = 12
        layer?.backgroundColor = NSColor.windowBackgroundColor.withAlphaComponent(0.96).cgColor
        layer?.borderWidth = 1
        layer?.borderColor = NSColor.separatorColor.cgColor
        layer?.shadowColor = NSColor.black.cgColor
        layer?.shadowOpacity = 0.18
        layer?.shadowRadius = 10
        layer?.shadowOffset = CGSize(width: 0, height: -2)

        let icon = NSTextField(labelWithString: SCENARIO_EMOJI[bubble.scenario] ?? "💡")
        icon.font = NSFont.systemFont(ofSize: 15)
        let text = NSTextField(wrappingLabelWithString: bubble.text)
        text.font = NSFont.systemFont(ofSize: 13)
        text.maximumNumberOfLines = 3
        text.lineBreakMode = .byTruncatingTail
        let hint = NSTextField(labelWithString: "点开细聊")
        hint.font = NSFont.systemFont(ofSize: 10)
        hint.textColor = .tertiaryLabelColor

        let dismiss = NSButton(title: "✕", target: self, action: #selector(dismissTapped))
        dismiss.isBordered = false
        dismiss.font = NSFont.systemFont(ofSize: 11)
        dismiss.contentTintColor = .tertiaryLabelColor

        let top = NSStackView(views: [icon, text])
        top.orientation = .horizontal
        top.alignment = .top
        top.spacing = 6
        let bottom = NSStackView(views: [hint, NSView(), dismiss])
        bottom.orientation = .horizontal
        bottom.spacing = 6
        let outer = NSStackView(views: [top, bottom])
        outer.orientation = .vertical
        outer.alignment = .leading
        outer.spacing = 4
        outer.translatesAutoresizingMaskIntoConstraints = false
        addSubview(outer)
        NSLayoutConstraint.activate([
            outer.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            outer.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            outer.topAnchor.constraint(equalTo: topAnchor, constant: 8),
            outer.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -8),
            widthAnchor.constraint(equalToConstant: 288),
        ])

        let click = NSClickGestureRecognizer(target: self, action: #selector(openTapped))
        addGestureRecognizer(click)

        timer = Timer.scheduledTimer(withTimeInterval: 12, repeats: false) { [weak self] _ in
            guard let self, !self.hovering else { return }
            self.onSelfDismiss?()
        }
    }

    required init?(coder: NSCoder) { nil }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let t = tracking { removeTrackingArea(t) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways], owner: self, userInfo: nil)
        addTrackingArea(area)
        tracking = area
    }

    override func mouseEntered(with event: NSEvent) {
        hovering = true
    }

    override func mouseExited(with event: NSEvent) {
        hovering = false
    }

    @objc private func openTapped() { onOpen?() }
    @objc private func dismissTapped() { onDismiss?() }
}