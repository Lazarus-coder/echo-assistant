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

final class OverlayController: NSObject, WKUIDelegate {
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

    func present(_ bubbles: [Bubble], onOpen: @escaping (Bubble) -> Void, onDismiss: @escaping (Bubble) -> Void, onExpire: @escaping (Bubble) -> Void) {
        guard !bubbles.isEmpty else { return }
        ensureWindow()
        guard let stack = stack, let w = window else { return }
        for b in bubbles where visible[b.id] == nil {
            let card = BubbleCard(bubble: b)
            card.onOpen = { [weak self] in
                self?.remove(b.id)
                onOpen(b)
            }
            card.onDismiss = { [weak self] in
                self?.remove(b.id)
                onDismiss(b)
            }
            card.onSelfDismiss = { [weak self] in
                onExpire(b)
                self?.remove(b.id)
            }
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
                (view as? BubbleCard)?.expire()
            }
        }
        reposition()
        w.orderFrontRegardless()
        w.ignoresMouseEvents = false
    }

    private func remove(_ id: String) {
        guard let view = visible[id], let stack = stack else { return }
        (view as? BubbleCard)?.stopAutoDismiss()
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
        let config = WKWebViewConfiguration()
        if let source = Self.miniAuthScript(origin: "http://127.0.0.1:\(port)", token: token) {
            config.userContentController.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        let web = WKWebView(frame: panel.contentView?.bounds ?? .zero, configuration: config)
        web.uiDelegate = self
        web.autoresizingMask = [.width, .height]
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

    static func miniAuthScript(origin: String, token: String) -> String? {
        guard !token.isEmpty,
              let data = try? JSONSerialization.data(withJSONObject: ["origin": origin, "token": token]),
              let payload = String(data: data, encoding: .utf8) else { return nil }
        // 只给本机小窗注入；mini.js 读取后删除，外部网页和子框架拿不到口令。
        return """
        (() => {
          const auth = \(payload);
          if (location.origin === auth.origin && location.pathname === '/mini.html') {
            Object.defineProperty(window, '__echoLocalToken', { value: auth.token, configurable: true });
          }
        })();
        """
    }

    static func browserURL(_ url: URL?) -> URL? {
        guard let url, let scheme = url.scheme?.lowercased(),
              ["http", "https"].contains(scheme), url.host != nil else { return nil }
        return url
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if navigationAction.targetFrame == nil, let url = Self.browserURL(navigationAction.request.url) {
            NSWorkspace.shared.open(url)
        }
        return nil
    }
}

/// 单张气泡：图标 + 一句话 + 悬停显示的按钮；12 秒自动淡出（鼠标停在上面就不走）
final class BubbleCard: NSView {
    var onOpen: (() -> Void)?
    var onDismiss: (() -> Void)?
    var onSelfDismiss: (() -> Void)?
    private var tracking: NSTrackingArea?
    private var timer: Timer?
    private var resolved = false

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

        scheduleAutoDismiss()
    }

    required init?(coder: NSCoder) { nil }

    deinit { timer?.invalidate() }

    func stopAutoDismiss() {
        timer?.invalidate()
        timer = nil
    }

    func expire() {
        guard finish() else { return }
        onSelfDismiss?()
    }

    private func scheduleAutoDismiss() {
        guard !resolved else { return }
        stopAutoDismiss()
        timer = Timer.scheduledTimer(withTimeInterval: 12, repeats: false) { [weak self] _ in
            self?.expire()
        }
    }

    private func finish() -> Bool {
        guard !resolved else { return false }
        resolved = true
        stopAutoDismiss()
        return true
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let t = tracking { removeTrackingArea(t) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways], owner: self, userInfo: nil)
        addTrackingArea(area)
        tracking = area
    }

    override func mouseEntered(with event: NSEvent) {
        stopAutoDismiss()
    }

    override func mouseExited(with event: NSEvent) {
        scheduleAutoDismiss()
    }

    @objc private func openTapped() {
        guard finish() else { return }
        onOpen?()
    }
    @objc private func dismissTapped() {
        guard finish() else { return }
        onDismiss?()
    }
}
