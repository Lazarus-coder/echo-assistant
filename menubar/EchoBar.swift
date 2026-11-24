import AppKit
import Foundation
import Vision

// Native status menu and quick actions.
// Authenticate local API requests using the profile’s data/local.token.

let env = ProcessInfo.processInfo.environment
let rootPath = env["ECHO_ROOT"] ?? FileManager.default.currentDirectoryPath
let profileData = URL(fileURLWithPath: env["ECHO_DATA_DIR"].flatMap { $0.isEmpty ? nil : $0 } ?? rootPath + "/data",
                      isDirectory: true).standardizedFileURL
let port = env["ECHO_PORT"] ?? "8787"
let base = URL(string: "http://127.0.0.1:\(port)")!
let serviceLabel = env["ECHO_SERVICE"] ?? "com.echo.chat"

func localToken() -> String {
    return (try? String(contentsOf: profileData.appendingPathComponent("local.token"), encoding: .utf8))?
        .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
}

func temporaryCaptureFile() throws -> URL {
    let spool = profileData.appendingPathComponent("spool", isDirectory: true)
    let fm = FileManager.default
    do {
        try fm.createDirectory(at: spool, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    } catch CocoaError.fileWriteFileExists { }
    let attributes = try fm.attributesOfItem(atPath: spool.path)
    guard attributes[.type] as? FileAttributeType == .typeDirectory else { throw CocoaError(.fileWriteNoPermission) }
    if (attributes[.posixPermissions] as? NSNumber)?.intValue != 0o700 {
        try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: spool.path)
    }
    return spool.appendingPathComponent("capture-\(UUID().uuidString).jpg")
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
        if let listener = j["listener"] as? [String: Any] { lanURL = listener["lanUrl"] as? String ?? "" }
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

/* Screen capture and on-device OCR */

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

func request(_ path: String, query: [URLQueryItem] = [], method: String = "GET", body: [String: Any]? = nil, timeout: TimeInterval = 20,
             completion: @escaping ([String: Any]?) -> Void) {
    let endpoint = base.appendingPathComponent("api/" + path)
    var req = URLRequest(url: query.isEmpty ? endpoint : endpoint.appending(queryItems: query))
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
    guard let iso else { return menuText("Never") }
    let fmt = ISO8601DateFormatter()
    fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    guard let date = fmt.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else { return "—" }
    let mins = Int(Date().timeIntervalSince(date) / 60)
    if mins < 1 { return menuText("Just now") }
    if mins < 60 { return menuText("%@ min ago", mins) }
    if mins < 60 * 24 { return menuText("%@ hr ago", mins / 60) }
    return menuText("%@ d ago", mins / (60 * 24))
}

final class Controller: NSObject, NSApplicationDelegate {
    var item: NSStatusItem!
    var summary = Summary(nil)
    var timer: Timer?
    var working = false
    var capturing = false
    var lastScreenCaptureAt = Date.distantPast
    var lastCompanionCaptureAt = Date.distantPast

    func recordCaptureIfDue(companion: Bool, force: Bool, now: Date = Date()) -> Bool {
        let interval = companion ? summary.companionInterval : summary.screenInterval * 60
        let previous = companion ? lastCompanionCaptureAt : lastScreenCaptureAt
        guard force || now.timeIntervalSince(previous) >= Double(interval) else { return false }
        if companion { lastCompanionCaptureAt = now } else { lastScreenCaptureAt = now }
        return true
    }

    /** Capture on demand and remove temporary images after OCR. */
    func maybeCapture(force: Bool, companion: Bool = false) {
        if companion {
            guard summary.ok, summary.companionOn, !summary.companionPaused, !capturing else { return }
        } else {
            guard summary.ok, summary.screenOn, !capturing else { return }
        }
        guard screenPermission() else {
            if force && !companion {
                capturing = true
                request("screen", method: "POST", body: ["fromCapture": true, "captureFailed": true, "captureIssue": "screen_permission_required"]) { [weak self] _ in
                    DispatchQueue.main.async { self?.capturing = false }
                }
            }
            return
        }
        if sessionLocked() { return }
        let idle = hidIdleSeconds()
        if idle > summary.screenIdleSkip { return }
        guard recordCaptureIfDue(companion: companion, force: force) else { return }
        capturing = true
        let appName = NSWorkspace.shared.frontmostApplication?.localizedName ?? ""
        let title = frontmostWindowTitle()
        let capturedAt = Date().ISO8601Format(.init(includingFractionalSeconds: true))
        let mode = summary.screenMode
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let tmp = try? temporaryCaptureFile()
            defer { if let tmp { try? FileManager.default.removeItem(at: tmp) } }
            let img = tmp.flatMap { file -> NSImage? in
                guard runSync("/usr/sbin/screencapture", ["-x", "-t", "jpg", file.path], timeout: 25) else { return nil }
                return NSImage(contentsOf: file)
            }
            let ok = img != nil
            var body: [String: Any] = ["fromCapture": true, "captureFailed": !ok]
            if companion { body["ts"] = capturedAt }
            if let img {
                body["app"] = appName
                body["title"] = title
                body["hidIdleSeconds"] = idle
                body["text"] = String(ocr(downscale(img, maxEdge: 2200)).prefix(8000))
                if !companion, mode == "image", let b64 = jpegBase64(img) { body["image"] = "data:image/jpeg;base64," + b64 }
            }
            let endpoint = companion ? "companion/frame" : "screen"
            request(endpoint, method: "POST", body: body, timeout: 240) { json in
                DispatchQueue.main.async {
                    self?.capturing = false
                    let skipped = (json?["skipped"] as? String)?.components(separatedBy: ":").first
                    let hasBubble = json?["bubble"] is [String: Any]
                    print("[capture:\(endpoint)] ok=\(ok) skipped=\(skipped ?? "-") bubble=\(hasBubble)")
                    if force || hasBubble { self?.refresh() }
                }
            }
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.image = glyph(unread: 0)
        item.button?.toolTip = menuText("Echo · Local chat")
        rebuildMenu()
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 20, repeats: true) { [weak self] _ in self?.refresh() }
        RunLoop.current.add(timer!, forMode: .common)
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(didWake),
                                                         name: NSWorkspace.didWakeNotification, object: nil)
    }

    @objc func didWake(_ notification: Notification) {
        request("research/reconcile", method: "POST", body: [:]) { _ in }
        refresh()
    }

    func applyProfileLanguage(_ json: [String: Any]?) {
        guard json?["ok"] as? Bool == true, let language = json?["language"] as? String,
              ["en", "zh-CN"].contains(language), language != menuLanguage else { return }
        menuLanguage = language
        overlay.updateLanguage()
    }

    func refresh() {
        request("summary") { [weak self] json in
            guard let self else { return }
            let prev = self.summary
            self.summary = Summary(json)
            self.applyProfileLanguage(json)
            self.item.button?.image = glyph(unread: self.summary.unread)
            self.item.button?.toolTip = self.summary.ok
                ? menuText("Echo is running · %@ unread · %@ check-ins today", self.summary.unread, self.summary.proactiveToday)
                : menuText("Echo is offline. Open the menu to restart the service.")
            if self.summary.unread > prev.unread, self.summary.ok {
                print(menuText("[menubar] Unread messages: %@", self.summary.unread))
            }
            self.rebuildMenu()
            if self.summary.companionOn, !self.summary.companionPaused { self.pollBubbles() }
            if self.summary.captureRequested {
                self.maybeCapture(force: true)
            } else {
                self.maybeCapture(force: false)
            }
            if self.summary.companionOn, !self.summary.companionPaused {
                self.maybeCapture(force: false, companion: true)
            }
        }
    }

    func mk(_ title: String, _ action: Selector, key: String = "") -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        return item
    }

    // Show pending suggestions as floating bubbles and open the selected topic in a mini window.
    let overlay = OverlayController()
    let bubbleSince = Date().ISO8601Format(.init(includingFractionalSeconds: true))
    func pollBubbles() {
        request("companion/pending", query: [URLQueryItem(name: "since", value: bubbleSince)]) { [weak self] json in
            guard let self, self.summary.companionOn, !self.summary.companionPaused else { return }
            let list = (json?["bubbles"] as? [[String: Any]]) ?? []
            guard !list.isEmpty else { return }
            let bubbles = list.map { item in
                Bubble(
                    id: item["id"] as? String ?? "",
                    scenario: item["scenario"] as? String ?? "other",
                    topic: item["topic"] as? String ?? menuText("Companion"),
                    text: item["bubble"] as? String ?? "",
                    why: item["why"] as? String ?? ""
                )
            }.filter { !$0.id.isEmpty }
            print("[companion] presenting \(bubbles.count) bubble(s)")
            self.overlay.present(
                bubbles,
                onOpen: { b in
                    self.overlay.openMini(for: b, port: port, token: localToken())
                },
                onDismiss: { b, reason in
                    request("companion/\(b.id)/dismiss", method: "POST", body: ["reason": reason]) { _ in self.refresh() }
                },
                onExpire: { b in
                    // An expired bubble is distinct from an explicit dismissal.
                    request("companion/\(b.id)/expire", method: "POST", body: [:]) { _ in }
                }
            )
        }
    }

    func rebuildMenu() {
        let s = summary
        let menu = NSMenu()
        let header = NSMenuItem(title: s.ok ? menuText("Echo · Running") : menuText("Echo · Offline"), action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)

        if s.ok {
            let info = NSMenuItem(
                title: menuText("Unread %@ · Check-ins today %@ · Follow-ups %@ · Memories %@", s.unread, s.proactiveToday, s.loops, s.memoryCount),
                action: nil, keyEquivalent: "")
            info.isEnabled = false
            menu.addItem(info)
            let dream = NSMenuItem(title: menuText("Last Dream: %@", humanAge(s.dreamLastAt)), action: nil, keyEquivalent: "")
            dream.isEnabled = false
            menu.addItem(dream)
            if s.busy > 0 {
                let b = NSMenuItem(title: menuText("Generating a reply…"), action: nil, keyEquivalent: "")
                b.isEnabled = false
                menu.addItem(b)
            }
            if !s.lastPreview.isEmpty {
                let p = NSMenuItem(title: menuText("Recent: %@", String(s.lastPreview.prefix(38))), action: nil, keyEquivalent: "")
                p.isEnabled = false
                menu.addItem(p)
            }
        }
        menu.addItem(.separator())
        if !screenPermission() {
            menu.addItem(mk(menuText("Grant Screen Recording permission for screen awareness…"), #selector(grantPermission)))
        }
        menu.addItem(mk(summary.screenOn ? menuText("Screen awareness: on (local OCR every %@ min)", summary.screenInterval) : menuText("Screen awareness: off"), #selector(toggleScreen)))
        if let act = summary.screenActivity, !act.isEmpty {
            let line = NSMenuItem(title: menuText("Now: %@ · %@", summary.screenApp ?? "", act), action: nil, keyEquivalent: "")
            line.isEnabled = false
            menu.addItem(line)
        }
        if s.screenOn { menu.addItem(mk(menuText("Read the screen now"), #selector(lookNow))) }
        menu.addItem(.separator())
        menu.addItem(mk(summary.companionOn ? menuText("Companion: on (checks every %@ sec)", summary.companionInterval) : menuText("Companion: off"), #selector(toggleCompanion)))
        if summary.companionOn {
            menu.addItem(mk(summary.companionPaused ? menuText("Resume companion") : menuText("Pause companion for 30 minutes"), #selector(pauseCompanion)))
            if summary.companionPending > 0 {
                let p = NSMenuItem(title: menuText("Pending bubbles: %@", summary.companionPending), action: nil, keyEquivalent: "")
                p.isEnabled = false
                menu.addItem(p)
            }
        }
        if summary.fading > 0 {
            let f = NSMenuItem(title: menuText("Memories nearing expiry: %@", summary.fading), action: nil, keyEquivalent: "")
            f.isEnabled = false
            menu.addItem(f)
        }
        menu.addItem(.separator())

        menu.addItem(mk(menuText("Open chat"), #selector(openChat), key: "o"))
        menu.addItem(mk(menuText("Check for a timely suggestion"), #selector(sayNow)))
        menu.addItem(mk(menuText("Run Dream memory review"), #selector(dreamNow)))
        menu.addItem(mk(s.proactiveOn ? menuText("Pause proactive assistance") : menuText("Resume proactive assistance"), #selector(toggleProactive)))
        menu.addItem(.separator())

        if !summary.lanURL.isEmpty {
            let copy = mk(menuText("Copy mobile URL (%@)", summary.lanURL), #selector(copyLAN))
            copy.representedObject = summary.lanURL
            menu.addItem(copy)
        }
        menu.addItem(mk(menuText("Open logs folder"), #selector(openLogs)))
        menu.addItem(mk(menuText("Restart Echo service"), #selector(restartService), key: "r"))
        menu.addItem(.separator())
        menu.addItem(mk(menuText("Quit menu bar icon (keep service running)"), #selector(quit), key: "q"))

        item.menu = menu
    }

    @objc func openChat() { NSWorkspace.shared.open(base) }

    @objc func grantPermission() {
        let ok = requestScreenPermission()
        notify(title: menuText("Echo screen awareness"), body: ok ? menuText("Permission granted. Echo can now read the screen.") : menuText("Enable EchoBar under System Settings → Privacy & Security → Screen Recording, then restart the menu bar app."))
    }

    @objc func toggleScreen() {
        let want = !summary.screenOn
        request("screen", method: "PATCH", body: ["screen": ["enabled": want]]) { [weak self] _ in
            self?.notify(title: menuText("Echo screen awareness"), body: want ? menuText("Local OCR enabled every %@ min.", self?.summary.screenInterval ?? 5) : menuText("Turned off."))
            self?.refresh()
        }
    }

    @objc func lookNow() { maybeCapture(force: true) }

    @objc func toggleCompanion() {
        let want = !summary.companionOn
        request("companion", method: "PATCH", body: ["companion": ["enabled": want]]) { [weak self] _ in
            self?.notify(title: menuText("Echo companion"), body: want ? menuText("Companion is on. Echo will check the screen more often and occasionally show a bubble.") : menuText("Turned off."))
            self?.refresh()
        }
    }

    @objc func pauseCompanion() {
        request("companion/pause", method: "POST", body: ["minutes": summary.companionPaused ? 0 : 30]) { [weak self] _ in
            self?.notify(title: menuText("Echo companion"), body: self?.summary.companionPaused == true ? menuText("Resumed.") : menuText("Paused for 30 minutes."))
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
            self?.notify(title: acted ? menuText("Message from Echo") : menuText("No check-in"), body: acted ? (msg ?? "") : menuText("Echo decided to wait for a better moment."))
            self?.refresh()
        }
    }

    @objc func dreamNow() {
        guard !working else { return }
        working = true
        notify(title: "Echo", body: menuText("Dream is reviewing your memories. You’ll get a notification when it finishes."))
        request("dream", method: "POST", body: [:], timeout: 300) { [weak self] json in
            self?.working = false
            let ok = ((json?["result"] as? [String: Any])?["ok"] as? Bool) ?? false
            let summary = ((json?["result"] as? [String: Any])?["summary"] as? [String])?.joined(separator: menuLanguage == "zh-CN" ? "；" : "; ") ?? ""
            self?.notify(title: ok ? menuText("Dream complete") : menuText("Dream failed"), body: ok ? summary : menuText("See data/logs/echo.err.log for details."))
            self?.refresh()
        }
    }

    @objc func toggleProactive() {
        let want = !summary.proactiveOn
        request("proactive", method: "PATCH", body: ["enabled": want]) { [weak self] _ in
            self?.notify(title: "Echo", body: want ? menuText("Proactive assistance is on.") : menuText("Proactive assistance paused."))
            self?.refresh()
        }
    }

    @objc func copyLAN(_ sender: NSMenuItem) {
        guard let text = sender.representedObject as? String else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        notify(title: menuText("Copied"), body: text)
    }

    @objc func openLogs() {
        NSWorkspace.shared.open(profileData.appendingPathComponent("logs", isDirectory: true))
    }

    @objc func restartService() {
        let uid = getuid()
        run("/bin/launchctl", ["kickstart", "-k", "gui/\(uid)/\(serviceLabel)"])
        notify(title: "Echo", body: menuText("Service restart requested."))
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { self.refresh() }
    }

    @objc func quit() { NSApp.terminate(nil) }

    func notify(title: String, body: String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        p.arguments = ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv) sound name \"Glass\"", "-e", "end run", "--", title, String(body.prefix(140))]
        try? p.run()
    }
}


// Summary responses update the profile language on the main queue. Before
// connecting, Finder launches use the preferred system language.
var menuLanguage = {
    let value = env["ECHO_LANGUAGE"] ?? Locale.preferredLanguages.first ?? "en"
    return value.lowercased().hasPrefix("zh") ? "zh-CN" : "en"
}()

func menuText(_ english: String, _ arguments: CustomStringConvertible...) -> String {
    let format = menuLanguage == "zh-CN" ? menuChinese[english] ?? english : english
    return String(format: format, arguments: arguments.map { $0.description })
}

private let menuChinese = [
    "Never": "从未",
    "Just now": "刚刚",
    "%@ min ago": "%@ 分钟前",
    "%@ hr ago": "%@ 小时前",
    "%@ d ago": "%@ 天前",
    "Echo · Local chat": "Echo · 本地对话",
    "Echo is running · %@ unread · %@ check-ins today": "Echo 运行中 · 未读 %@ · 今日主动 %@",
    "Echo is offline. Open the menu to restart the service.": "Echo 未运行（点菜单里的重启服务）",
    "[menubar] Unread messages: %@": "[menubar] 未读消息：%@",
    "Companion": "伴随",
    "Echo · Running": "Echo · 运行中",
    "Echo · Offline": "Echo · 未运行",
    "Unread %@ · Check-ins today %@ · Follow-ups %@ · Memories %@": "未读 %@ · 今日主动 %@ · 跟进 %@ 条 · 记忆 %@ 条",
    "Last Dream: %@": "上次 Dream：%@",
    "Generating a reply…": "正在生成回复…",
    "Recent: %@": "最近：%@",
    "Grant Screen Recording permission for screen awareness…": "⚠️ 屏幕感知需要「屏幕录制」权限 → 点此授权",
    "Screen awareness: on (local OCR every %@ min)": "屏幕感知：开（每 %@ 分钟，本地 OCR）",
    "Screen awareness: off": "屏幕感知：关",
    "Now: %@ · %@": "此刻：%@｜%@",
    "Read the screen now": "现在看一眼（立即感知一次）",
    "Companion: on (checks every %@ sec)": "伴随模式：开（每 %@ 秒看一眼）",
    "Companion: off": "伴随模式：关",
    "Resume companion": "恢复伴随（结束暂停）",
    "Pause companion for 30 minutes": "暂停伴随 30 分钟",
    "Pending bubbles: %@": "有 %@ 个气泡在等你",
    "Memories nearing expiry: %@": "记忆：%@ 条接近淡出阈值",
    "Open chat": "打开对话窗口",
    "Check for a timely suggestion": "让它主动说一句",
    "Run Dream memory review": "立即 Dream 提炼",
    "Pause proactive assistance": "暂停主动服务",
    "Resume proactive assistance": "恢复主动服务",
    "Copy mobile URL (%@)": "复制手机访问地址（%@）",
    "Open logs folder": "打开日志目录",
    "Restart Echo service": "重启 Echo 服务",
    "Quit menu bar icon (keep service running)": "退出状态栏图标（服务继续运行）",
    "Echo screen awareness": "Echo 屏幕感知",
    "Permission granted. Echo can now read the screen.": "已获得授权，屏幕感知可以工作了",
    "Enable EchoBar under System Settings → Privacy & Security → Screen Recording, then restart the menu bar app.": "请在「系统设置 → 隐私与安全性 → 屏幕录制」里勾选 EchoBar，然后重启状态栏",
    "Local OCR enabled every %@ min.": "已开启：每 %@ 分钟本地 OCR 一次",
    "Turned off.": "已关闭",
    "Echo companion": "Echo 伴随模式",
    "Companion is on. Echo will check the screen more often and occasionally show a bubble.": "已开启：会提高看屏幕的频率，用气泡偶尔说一句（可随时暂停）",
    "Resumed.": "已恢复",
    "Paused for 30 minutes.": "暂停 30 分钟",
    "Message from Echo": "Echo 主动发言",
    "No check-in": "这次没说",
    "Echo decided to wait for a better moment.": "判断现在不适合打扰",
    "Dream is reviewing your memories. You’ll get a notification when it finishes.": "开始 Dream 提炼，完成后会再通知你",
    "Dream complete": "Dream 完成",
    "Dream failed": "Dream 失败",
    "See data/logs/echo.err.log for details.": "看日志 data/logs/echo.err.log",
    "Proactive assistance is on.": "主动服务已开启",
    "Proactive assistance paused.": "主动服务已暂停",
    "Copied": "已复制",
    "Service restart requested.": "已请求重启服务",
    "Companion · %@": "伴随 · %@",
    "Click to chat": "点开细聊",
    "Dismiss bubble": "收起气泡",
    "Bad timing": "时机不合适",
    "Pause interruptions for 30 minutes and remember the timing of this bubble.": "暂缓打扰 30 分钟，并记住这次气泡出现的时段",
]
