import AppKit
import Foundation
import Vision

// Echo 状态栏：显示服务状态、未读主动消息，并提供快捷操作。
// 通过 data/local.token 以本机身份访问 http://127.0.0.1:<port>/api/*。

let env = ProcessInfo.processInfo.environment
let rootPath = env["ECHO_ROOT"] ?? FileManager.default.currentDirectoryPath
let port = env["ECHO_PORT"] ?? "8787"
let base = URL(string: "http://127.0.0.1:\(port)")!
let serviceLabel = env["ECHO_SERVICE"] ?? "com.echo.chat"

func localToken() -> String {
    let path = rootPath + "/data/local.token"
    return (try? String(contentsOfFile: path, encoding: .utf8))?
        .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
}

struct Summary {
    var ok = false
    var unread = 0
    var proactiveToday = 0
    var loops = 0
    var memoryCount = 0
    var dreamLastAt: String?
    var proactiveOn = true
    var searchOn = true
    var busy = 0
    var lastPreview = ""
    var lanURL = ""
    var screenOn = false
    var screenMode = "ocr"
    var screenInterval = 5
    var screenIdleSkip = 180
    var captureRequested = false
    var captureReason: String?
    var screenActivity: String?
    var screenApp: String?
    var fading = 0
    var companionOn = false
    var companionPaused = false
    var companionInterval = 20
    var companionPending = 0

    init(_ j: [String: Any]?) {
        guard let j, j["ok"] as? Bool == true else { return }
        ok = true
        unread = j["unread"] as? Int ?? 0
        proactiveToday = j["proactiveToday"] as? Int ?? 0
        loops = j["loops"] as? Int ?? 0
        busy = j["busy"] as? Int ?? 0
        dreamLastAt = j["dreamLastAt"] as? String
        lastPreview = (j["lastPreview"] as? String ?? "").replacingOccurrences(of: "\n", with: " ")
        if let m = j["memory"] as? [String: Any] { memoryCount = m["observations"] as? Int ?? 0 }
        if let f = j["forgetting"] as? [String: Any] { fading = f["fadingSoon"] as? Int ?? 0 }
        if let s = j["screen"] as? [String: Any] {
            screenOn = s["enabled"] as? Bool ?? false
            screenMode = s["mode"] as? String ?? "ocr"
            screenInterval = s["intervalMinutes"] as? Int ?? 5
            screenIdleSkip = s["idleSkipSeconds"] as? Int ?? 180
            captureRequested = s["captureRequested"] as? Bool ?? false
            captureReason = s["captureReason"] as? String
            screenActivity = s["activity"] as? String
            screenApp = s["app"] as? String
        }
        if let e = j["enabled"] as? [String: Any] {
            proactiveOn = e["proactive"] as? Bool ?? true
            searchOn = e["search"] as? Bool ?? true
        }
        if let c = j["companion"] as? [String: Any] {
            companionOn = c["enabled"] as? Bool ?? false
            companionPaused = c["paused"] as? Bool ?? false
            companionInterval = c["intervalSeconds"] as? Int ?? 20
            companionPending = c["pending"] as? Int ?? 0
        }
    }
}

/* --------------------------- 屏幕感知（本地 OCR） --------------------------- */

func runSync(_ launchPath: String, _ args: [String], timeout: TimeInterval = 20) -> Bool {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: launchPath)
    p.arguments = args
    p.standardOutput = FileHandle.nullDevice
    p.standardError = FileHandle.nullDevice
    do { try p.run() } catch { return false }
    let deadline = Date().addingTimeInterval(timeout)
    while p.isRunning && Date() < deadline { usleep(120_000) }
    if p.isRunning { p.terminate(); return false }
    return p.terminationStatus == 0
}

func screenPermission() -> Bool { CGPreflightScreenCaptureAccess() }

func requestScreenPermission() -> Bool {
    let ok = CGRequestScreenCaptureAccess()
    if !ok {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") {
            NSWorkspace.shared.open(url)
        }
    }
    return ok
}

func frontmostWindowTitle() -> String {
    guard let app = NSWorkspace.shared.frontmostApplication else { return "" }
    let pid = app.processIdentifier
    let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else { return "" }
    for w in list {
        if (w[kCGWindowOwnerPID as String] as? Int32) == pid,
           let name = w[kCGWindowName as String] as? String, !name.isEmpty {
            return String(name.prefix(120))
        }
    }
    return ""
}

func hidIdleSeconds() -> Int {
    guard let anyEvent = CGEventType(rawValue: 0xFFFF_FFFF) else { return 0 }
    return Int(CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: anyEvent))
}

func sessionLocked() -> Bool {
    guard let dict = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
    return (dict["CGSSessionScreenIsLocked"] as? Bool) ?? false
}

func downscale(_ image: NSImage, maxEdge: CGFloat) -> NSImage {
    let size = image.size
    let scale = min(1, maxEdge / max(size.width, size.height))
    if scale >= 1 { return image }
    let target = NSSize(width: max(1, size.width * scale), height: max(1, size.height * scale))
    let out = NSImage(size: target)
    out.lockFocus()
    NSGraphicsContext.current?.imageInterpolation = .high
    image.draw(in: NSRect(origin: .zero, size: target))
    out.unlockFocus()
    return out
}

func ocr(_ image: NSImage) -> String {
    var cg: CGImage?
    var rect = NSRect(origin: .zero, size: image.size)
    cg = image.cgImage(forProposedRect: &rect, context: nil, hints: nil)
    guard let cgImage = cg else { return "" }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["zh-Hans", "en-US"]
    request.usesLanguageCorrection = true
    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    do { try handler.perform([request]) } catch { return "" }
    let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
    return lines.joined(separator: "\n")
}

func jpegBase64(_ image: NSImage, maxEdge: CGFloat = 1280, quality: CGFloat = 0.7) -> String? {
    let small = downscale(image, maxEdge: maxEdge)
    guard let tiff = small.tiffRepresentation,
          let rep = NSBitmapImageRep(data: tiff),
          let data = rep.representation(using: .jpeg, properties: [.compressionFactor: quality]) else { return nil }
    return data.base64EncodedString()
}

func request(_ path: String, method: String = "GET", body: [String: Any]? = nil, timeout: TimeInterval = 20,
             completion: @escaping ([String: Any]?) -> Void) {
    var req = URLRequest(url: base.appendingPathComponent("api/" + path))
    req.httpMethod = method
    req.timeoutInterval = timeout
    req.setValue(localToken(), forHTTPHeaderField: "x-echo-local")
    if let body {
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.setValue("echo", forHTTPHeaderField: "x-echo-request")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
    }
    URLSession.shared.dataTask(with: req) { data, _, _ in
        var json: [String: Any]?
        if let data { json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] }
        DispatchQueue.main.async { completion(json) }
    }.resume()
}

func lanAddress() -> String {
    var address = ""
    var ifaddr: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&ifaddr) == 0, let first = ifaddr else { return "" }
    defer { freeifaddrs(ifaddr) }
    for ptr in sequence(first: first, next: { $0.pointee.ifa_next }) {
        let ifa = ptr.pointee
        guard ifa.ifa_addr.pointee.sa_family == UInt8(AF_INET) else { continue }
        let name = String(cString: ifa.ifa_name)
        guard name == "en0" || name == "en1" else { continue }
        var buf = [CChar](repeating: 0, count: Int(NI_MAXHOST))
        if getnameinfo(ifa.ifa_addr, socklen_t(ifa.ifa_addr.pointee.sa_len), &buf, socklen_t(buf.count), nil, 0, NI_NUMERICHOST) == 0 {
            address = String(cString: buf)
            break
        }
    }
    return address
}

func glyph(unread: Int) -> NSImage {
    let size = NSSize(width: 21, height: 18)
    let img = NSImage(size: size)
    img.lockFocus()
    NSColor.black.setFill()
    NSBezierPath(ovalIn: NSRect(x: 2.0, y: 7.0, width: 4.6, height: 4.6)).fill()
    let arcs: [(CGFloat, CGFloat)] = [(4.2, 1.0), (7.6, 0.62), (11.0, 0.3)]
    for (radius, alpha) in arcs {
        NSColor.black.withAlphaComponent(alpha).setStroke()
        let p = NSBezierPath()
        p.appendArc(withCenter: NSPoint(x: 4.3, y: 9.3), radius: radius, startAngle: -52, endAngle: 52)
        p.lineWidth = 1.7
        p.lineCapStyle = .round
        p.stroke()
    }
    img.unlockFocus()
    if unread > 0 {
        img.lockFocus()
        NSColor.systemRed.setFill()
        NSBezierPath(ovalIn: NSRect(x: 15.0, y: 12.0, width: 5.0, height: 5.0)).fill()
        img.unlockFocus()
        img.isTemplate = false
    } else {
        img.isTemplate = true
    }
    return img
}

func run(_ launchPath: String, _ args: [String]) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: launchPath)
    p.arguments = args
    try? p.run()
}

func humanAge(_ iso: String?) -> String {
    guard let iso else { return "从未" }
    let fmt = ISO8601DateFormatter()
    fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    guard let date = fmt.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else { return "—" }
    let mins = Int(Date().timeIntervalSince(date) / 60)
    if mins < 1 { return "刚刚" }
    if mins < 60 { return "\(mins) 分钟前" }
    if mins < 60 * 24 { return "\(mins / 60) 小时前" }
    return "\(mins / (60 * 24)) 天前"
}

final class Controller: NSObject, NSApplicationDelegate {
    var item: NSStatusItem!
    var summary = Summary(nil)
    var timer: Timer?
    var working = false
    var capturing = false
    var lastCaptureAt = Date.distantPast

    /** 定期（或被要求时）看一眼屏幕：本地 OCR，图片不落盘，删掉临时文件。 */
    func maybeCapture(force: Bool, reason: String, companion: Bool = false) {
        let intervalSeconds = companion ? summary.companionInterval : summary.screenInterval * 60
        if companion {
            guard summary.ok, summary.companionOn, !summary.companionPaused, !capturing else { return }
        } else {
            guard summary.ok, summary.screenOn, !capturing else { return }
        }
        guard screenPermission() else { return }
        if sessionLocked() { return }
        let idle = hidIdleSeconds()
        if idle > summary.screenIdleSkip { return }
        if !force, Date().timeIntervalSince(lastCaptureAt) < Double(intervalSeconds) { return }
        capturing = true
        lastCaptureAt = Date()
        let appName = NSWorkspace.shared.frontmostApplication?.localizedName ?? ""
        let title = frontmostWindowTitle()
        let mode = summary.screenMode
        let tmp = NSTemporaryDirectory() + "echo-capture-\(Int(Date().timeIntervalSince1970)).jpg"
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let ok = runSync("/usr/sbin/screencapture", ["-x", "-t", "jpg", tmp], timeout: 25)
            defer { try? FileManager.default.removeItem(atPath: tmp) }
            var body: [String: Any] = ["text": "", "app": appName, "title": title, "hidIdleSeconds": idle, "fromCapture": true]
            if ok, let img = NSImage(contentsOfFile: tmp) {
                body["text"] = String(ocr(downscale(img, maxEdge: 2200)).prefix(8000))
                if mode == "image", let b64 = jpegBase64(img) { body["image"] = "data:image/jpeg;base64," + b64 }
            }
            let endpoint = companion ? "companion/frame" : "screen"
            request(endpoint, method: "POST", body: body, timeout: 240) { json in
                DispatchQueue.main.async {
                    self?.capturing = false
                    let activity = ((json?["event"] as? [String: Any])?["activity"] as? String) ?? ""
                    let skipped = json?["skipped"] as? String
                    let bubble = (json?["bubble"] as? [String: Any])?["bubble"] as? String
                    print("[capture:\(endpoint)] \(reason) ok=\(ok) activity=\(activity) skipped=\(skipped ?? "-") bubble=\(bubble ?? "-")")
                    if force || bubble != nil { self?.refresh() }
                }
            }
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.image = glyph(unread: 0)
        item.button?.toolTip = "Echo · 本地对话"
        rebuildMenu()
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 20, repeats: true) { [weak self] _ in self?.refresh() }
        RunLoop.current.add(timer!, forMode: .common)
    }

    func refresh() {
        request("summary") { [weak self] json in
            guard let self else { return }
            let prev = self.summary
            self.summary = Summary(json)
            self.item.button?.image = glyph(unread: self.summary.unread)
            self.item.button?.toolTip = self.summary.ok
                ? "Echo 运行中 · 未读 \(self.summary.unread) · 今日主动 \(self.summary.proactiveToday)"
                : "Echo 未运行（点菜单里的重启服务）"
            if self.summary.unread > prev.unread, self.summary.ok {
                print("[menubar] 新主动消息：\(self.summary.lastPreview)")
            }
            self.rebuildMenu()
            if self.summary.companionOn { self.pollBubbles() }
            if self.summary.captureRequested {
                self.maybeCapture(force: true, reason: self.summary.captureReason ?? "requested")
            } else {
                self.maybeCapture(force: false, reason: "interval")
            }
            if self.summary.companionOn, !self.summary.companionPaused {
                self.maybeCapture(force: false, reason: "companion", companion: true)
            }
        }
    }

    func mk(_ title: String, _ action: Selector, key: String = "") -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        return item
    }

    // 伴随：轮询待冒泡的气泡 → 悬浮窗呈现；点开进小对话窗
    let overlay = OverlayController()
    func pollBubbles() {
        request("companion/pending") { [weak self] json in
            guard let self else { return }
            let list = (json?["bubbles"] as? [[String: Any]]) ?? []
            guard !list.isEmpty else { return }
            let bubbles = list.map { item in
                Bubble(
                    id: item["id"] as? String ?? "",
                    scenario: item["scenario"] as? String ?? "other",
                    topic: item["topic"] as? String ?? "伴随",
                    text: item["bubble"] as? String ?? "",
                    why: item["why"] as? String ?? ""
                )
            }.filter { !$0.id.isEmpty }
            print("[companion] presenting \(bubbles.count) bubble(s): \(bubbles.map { $0.text }.joined(separator: " | "))")
            self.overlay.present(
                bubbles,
                onOpen: { b in
                    self.overlay.openMini(for: b, port: port, token: localToken())
                    request("companion/\(b.id)/open", method: "POST", body: [:]) { _ in self.refresh() }
                },
                onDismiss: { b in
                    request("companion/\(b.id)/dismiss", method: "POST", body: ["reason": "menu_bubble"]) { _ in self.refresh() }
                }
            )
        }
    }

    func rebuildMenu() {
        let s = summary
        let menu = NSMenu()
        let header = NSMenuItem(title: s.ok ? "Echo · 运行中" : "Echo · 未运行", action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)

        if s.ok {
            let info = NSMenuItem(
                title: "未读 \(s.unread) · 今日主动 \(s.proactiveToday) · 跟进 \(s.loops) 条 · 记忆 \(s.memoryCount) 条",
                action: nil, keyEquivalent: "")
            info.isEnabled = false
            menu.addItem(info)
            let dream = NSMenuItem(title: "上次 Dream：\(humanAge(s.dreamLastAt))", action: nil, keyEquivalent: "")
            dream.isEnabled = false
            menu.addItem(dream)
            if s.busy > 0 {
                let b = NSMenuItem(title: "正在生成回复…", action: nil, keyEquivalent: "")
                b.isEnabled = false
                menu.addItem(b)
            }
            if !s.lastPreview.isEmpty {
                let p = NSMenuItem(title: "最近：\(String(s.lastPreview.prefix(38)))", action: nil, keyEquivalent: "")
                p.isEnabled = false
                menu.addItem(p)
            }
        }
        menu.addItem(.separator())
        if !screenPermission() {
            menu.addItem(mk("⚠️ 屏幕感知需要「屏幕录制」权限 → 点此授权", #selector(grantPermission)))
        }
        menu.addItem(mk(summary.screenOn ? "屏幕感知：开（每 \(summary.screenInterval) 分钟，本地 OCR）" : "屏幕感知：关", #selector(toggleScreen)))
        if let act = summary.screenActivity, !act.isEmpty {
            let line = NSMenuItem(title: "此刻：\(summary.screenApp ?? "")｜\(act)", action: nil, keyEquivalent: "")
            line.isEnabled = false
            menu.addItem(line)
        }
        menu.addItem(mk("现在看一眼（立即感知一次）", #selector(lookNow)))
        menu.addItem(.separator())
        menu.addItem(mk(summary.companionOn ? "伴随模式：开（每 \(summary.companionInterval) 秒看一眼）" : "伴随模式：关", #selector(toggleCompanion)))
        if summary.companionOn {
            menu.addItem(mk(summary.companionPaused ? "恢复伴随（结束暂停）" : "暂停伴随 30 分钟", #selector(pauseCompanion)))
            if summary.companionPending > 0 {
                let p = NSMenuItem(title: "有 \(summary.companionPending) 个气泡在等你", action: nil, keyEquivalent: "")
                p.isEnabled = false
                menu.addItem(p)
            }
        }
        if summary.fading > 0 {
            let f = NSMenuItem(title: "记忆：\(summary.fading) 条接近淡出阈值", action: nil, keyEquivalent: "")
            f.isEnabled = false
            menu.addItem(f)
        }
        menu.addItem(.separator())

        menu.addItem(mk("打开对话窗口", #selector(openChat), key: "o"))
        menu.addItem(mk("让它主动说一句", #selector(sayNow)))
        menu.addItem(mk("立即 Dream 提炼", #selector(dreamNow)))
        menu.addItem(mk(s.proactiveOn ? "暂停主动服务" : "恢复主动服务", #selector(toggleProactive)))
        menu.addItem(.separator())

        let lan = lanAddress()
        if !lan.isEmpty {
            let copy = mk("复制手机访问地址（局域网 \(lan)）", #selector(copyLAN))
            copy.representedObject = "http://\(lan):\(port)"
            menu.addItem(copy)
        }
        menu.addItem(mk("打开日志目录", #selector(openLogs)))
        menu.addItem(mk("重启 Echo 服务", #selector(restartService), key: "r"))
        menu.addItem(.separator())
        menu.addItem(mk("退出状态栏图标（服务继续运行）", #selector(quit), key: "q"))

        item.menu = menu
    }

    @objc func openChat() { NSWorkspace.shared.open(base) }

    @objc func grantPermission() {
        let ok = requestScreenPermission()
        notify(title: "Echo 屏幕感知", body: ok ? "已获得授权，屏幕感知可以工作了" : "请在「系统设置 → 隐私与安全性 → 屏幕录制」里勾选 EchoBar，然后重启状态栏")
    }

    @objc func toggleScreen() {
        let want = !summary.screenOn
        request("screen", method: "PATCH", body: ["screen": ["enabled": want]]) { [weak self] _ in
            self?.notify(title: "Echo 屏幕感知", body: want ? "已开启：每 \(self?.summary.screenInterval ?? 5) 分钟本地 OCR 一次" : "已关闭")
            self?.refresh()
        }
    }

    @objc func lookNow() { maybeCapture(force: true, reason: "manual") }

    @objc func toggleCompanion() {
        let want = !summary.companionOn
        request("companion", method: "PATCH", body: ["companion": ["enabled": want]]) { [weak self] _ in
            self?.notify(title: "Echo 伴随模式", body: want ? "已开启：会提高看屏幕的频率，用气泡偶尔说一句（可随时暂停）" : "已关闭")
            self?.refresh()
        }
    }

    @objc func pauseCompanion() {
        request("companion/pause", method: "POST", body: ["minutes": summary.companionPaused ? 0 : 30]) { [weak self] _ in
            self?.notify(title: "Echo 伴随模式", body: self?.summary.companionPaused == true ? "已恢复" : "暂停 30 分钟")
            self?.refresh()
        }
    }

    @objc func sayNow() {
        guard !working else { return }
        working = true
        request("proactive/run", method: "POST", body: [:], timeout: 120) { [weak self] json in
            self?.working = false
            let acted = (json?["result"] as? [String: Any])?["acted"] as? Bool ?? false
            let msg = ((json?["result"] as? [String: Any])?["message"] as? [String: Any])?["content"] as? String
            self?.notify(title: acted ? "Echo 主动发言" : "这次没说", body: acted ? (msg ?? "") : "判断现在不适合打扰")
            self?.refresh()
        }
    }

    @objc func dreamNow() {
        guard !working else { return }
        working = true
        notify(title: "Echo", body: "开始 Dream 提炼，完成后会再通知你")
        request("dream", method: "POST", body: [:], timeout: 300) { [weak self] json in
            self?.working = false
            let ok = ((json?["result"] as? [String: Any])?["ok"] as? Bool) ?? false
            let summary = ((json?["result"] as? [String: Any])?["summary"] as? [String])?.joined(separator: "；") ?? ""
            self?.notify(title: ok ? "Dream 完成" : "Dream 失败", body: ok ? summary : "看日志 data/logs/echo.err.log")
            self?.refresh()
        }
    }

    @objc func toggleProactive() {
        let want = !summary.proactiveOn
        request("proactive", method: "PATCH", body: ["enabled": want]) { [weak self] _ in
            self?.notify(title: "Echo", body: want ? "主动服务已开启" : "主动服务已暂停")
            self?.refresh()
        }
    }

    @objc func copyLAN(_ sender: NSMenuItem) {
        guard let text = sender.representedObject as? String else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        notify(title: "已复制", body: text)
    }

    @objc func openLogs() {
        NSWorkspace.shared.open(URL(fileURLWithPath: rootPath + "/data/logs"))
    }

    @objc func restartService() {
        let uid = getuid()
        run("/bin/launchctl", ["kickstart", "-k", "gui/\(uid)/\(serviceLabel)"])
        notify(title: "Echo", body: "已请求重启服务")
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { self.refresh() }
    }

    @objc func quit() { NSApp.terminate(nil) }

    func notify(title: String, body: String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        let safe = body.replacingOccurrences(of: "\"", with: "'").prefix(140)
        p.arguments = ["-e", "display notification \"\(safe)\" with title \"\(title)\" sound name \"Glass\""]
        try? p.run()
    }
}