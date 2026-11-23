import AppKit
import Foundation
import JavaScriptCore

// swiftc menubar/EchoBar.swift menubar/CompanionOverlay.swift tests/companion-ui.swift -o /tmp/echo-companion-ui-test
private final class BubblePollFixture: URLProtocol {
    static let received = DispatchSemaphore(value: 0)
    static var expectedSince = ""

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let parts = URLComponents(url: request.url!, resolvingAgainstBaseURL: true)!
        precondition(parts.host == "127.0.0.1" && parts.port == 1)
        precondition(request.value(forHTTPHeaderField: "x-echo-local") == "native-test-token")
        precondition(request.httpMethod == "GET" && parts.path == "/api/companion/pending")
        precondition(parts.queryItems == [URLQueryItem(name: "since", value: Self.expectedSince)])
        client?.urlProtocol(self, didFailWithError: URLError(.cancelled))
        Self.received.signal()
    }
    override func stopLoading() {}
}

@main
struct CompanionUITest {
    static func main() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let data = root.appendingPathComponent("data")
        try FileManager.default.createDirectory(at: data, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try "native-test-token\n".write(to: data.appendingPathComponent("local.token"), atomically: true, encoding: .utf8)
        setenv("ECHO_ROOT", root.path, 1)
        setenv("ECHO_PORT", "1", 1)
        let controller = Controller()
        precondition(URLProtocol.registerClass(BubblePollFixture.self))
        BubblePollFixture.expectedSince = controller.bubbleSince
        controller.pollBubbles()
        precondition(BubblePollFixture.received.wait(timeout: .now() + 5) == .success)
        URLProtocol.unregisterClass(BubblePollFixture.self)

        let start = Date()
        precondition(controller.recordCaptureIfDue(companion: false, force: false, now: start))
        for second in stride(from: 0, to: 300, by: 20) {
            precondition(controller.recordCaptureIfDue(companion: true, force: false, now: start.addingTimeInterval(Double(second))))
        }
        precondition(!controller.recordCaptureIfDue(companion: false, force: false, now: start.addingTimeInterval(299)))
        precondition(controller.recordCaptureIfDue(companion: false, force: false, now: start.addingTimeInterval(300)))

        _ = NSApplication.shared
        let token = "test-'\"\\\n</script>😀"
        let authScript = OverlayController.miniAuthScript(origin: "http://127.0.0.1:8787", token: token)!
        for (origin, pathname, allowed) in [
            ("http://127.0.0.1:8787", "/mini.html", true),
            ("http://127.0.0.1:8788", "/mini.html", false),
            ("https://example.com", "/mini.html", false),
            ("http://127.0.0.1:8787.evil.example", "/mini.html", false),
            ("http://127.0.0.1:8787", "/other.html", false),
        ] {
            let context = JSContext()!
            context.evaluateScript("var window = {}; var location = {};")
            context.objectForKeyedSubscript("location").setValue(origin, forProperty: "origin")
            context.objectForKeyedSubscript("location").setValue(pathname, forProperty: "pathname")
            context.evaluateScript(authScript)
            precondition(context.exception == nil, "Native credential must be safely serialized as JavaScript")
            let value = context.objectForKeyedSubscript("window").forProperty("__echoLocalToken")!
            precondition(allowed ? value.toString() == token : value.isUndefined, "Native credential must be restricted to the exact mini origin and path")
        }
        precondition(OverlayController.miniAuthScript(origin: "http://127.0.0.1:8787", token: "") == nil)
        for raw in ["http://127.0.0.1:8787/?conv=test", "https://example.com/source"] {
            precondition(OverlayController.browserURL(URL(string: raw))?.absoluteString == raw, "HTTP(S) links should open in the browser")
        }
        for raw in ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,hello", "echo://test"] {
            precondition(OverlayController.browserURL(URL(string: raw)) == nil, "Non-web link schemes must be rejected")
        }
        let bubble = Bubble(id: "test", scenario: "code", topic: "test", text: "test", why: "")

        let opened = BubbleCard(bubble: bubble)
        var opens = 0
        var expires = 0
        opened.onOpen = { opens += 1 }
        opened.onSelfDismiss = { expires += 1 }
        opened.perform(NSSelectorFromString("openTapped"))
        opened.perform(NSSelectorFromString("openTapped"))
        opened.expire()
        precondition(opens == 1 && expires == 0, "Opening a card must resolve it once and prevent expiry")

        let dismissed = BubbleCard(bubble: bubble)
        var dismissals = 0
        dismissed.onDismiss = { reason in precondition(reason == "menu_bubble"); dismissals += 1 }
        dismissed.onSelfDismiss = { expires += 1 }
        dismissed.perform(NSSelectorFromString("dismissTapped"))
        dismissed.perform(NSSelectorFromString("dismissTapped"))
        dismissed.expire()
        precondition(dismissals == 1 && expires == 0, "Dismissing a card must resolve it once and prevent expiry")

        let mistimed = BubbleCard(bubble: bubble)
        var reasons = [String]()
        mistimed.onDismiss = { reasons.append($0) }
        mistimed.onSelfDismiss = { expires += 1 }
        mistimed.perform(NSSelectorFromString("wrongTimeTapped"))
        mistimed.perform(NSSelectorFromString("dismissTapped"))
        mistimed.expire()
        precondition(reasons == ["wrong_time"] && expires == 0)

        let hovered = BubbleCard(bubble: bubble)
        hovered.onSelfDismiss = { expires += 1 }
        let enter = NSEvent.enterExitEvent(
            with: .mouseEntered, location: .zero, modifierFlags: [], timestamp: 0,
            windowNumber: 0, context: nil, eventNumber: 0, trackingNumber: 0, userData: nil
        )!
        let exit = NSEvent.enterExitEvent(
            with: .mouseExited, location: .zero, modifierFlags: [], timestamp: 0,
            windowNumber: 0, context: nil, eventNumber: 0, trackingNumber: 0, userData: nil
        )!
        hovered.mouseEntered(with: enter)
        RunLoop.current.run(until: Date().addingTimeInterval(12.2))
        precondition(expires == 0, "A hovered card must stay visible past the normal timeout")
        hovered.mouseExited(with: exit)
        RunLoop.current.run(until: Date().addingTimeInterval(12.2))
        precondition(expires == 1, "A card must resume auto-hide after the pointer leaves")
        hovered.expire()
        precondition(expires == 1, "An expired card must not send duplicate feedback")
        print("Companion UI regressions passed: native polling route, screen and companion cadence, scoped credentials, HTTP(S) links, bubble lifecycle and hover.")
    }
}
