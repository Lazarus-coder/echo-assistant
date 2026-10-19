// 渲染 Echo 的 App 图标（1024 与多尺寸 PNG），供 iconutil 打成 .icns。
// 用法：swiftc -O -o build/makeicon menubar/make-icon.swift && ./build/makeicon <outdir>
import AppKit
import Foundation

let outDir = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "."
let sizes = [16, 32, 64, 128, 256, 512, 1024]

func drawIcon(size: CGFloat) -> NSImage {
    let img = NSImage(size: NSSize(width: size, height: size))
    img.lockFocus()
    defer { img.unlockFocus() }
    let s = size

    // 圆角底：墨绿渐变（与网页 logo 同色）
    let inset = s * 0.08
    let rect = NSRect(x: inset, y: inset, width: s - inset * 2, height: s - inset * 2)
    let radius = (s - inset * 2) * 0.235
    let path = NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius)
    let gradient = NSGradient(colors: [
        NSColor(srgbRed: 0.24, green: 0.54, blue: 0.42, alpha: 1),
        NSColor(srgbRed: 0.14, green: 0.35, blue: 0.27, alpha: 1),
    ])!
    gradient.draw(in: path, angle: -45)

    // 回声：一个实心点 + 三道弧
    let cx = s * 0.375
    let cy = s * 0.5
    NSColor.white.setFill()
    let dot = NSBezierPath(ovalIn: NSRect(x: cx - s * 0.032, y: cy - s * 0.032, width: s * 0.064, height: s * 0.064))
    dot.fill()

    let arcs: [(CGFloat, CGFloat)] = [(0.115, 0.95), (0.205, 0.62), (0.295, 0.3)]
    for (r, alpha) in arcs {
        NSColor.white.withAlphaComponent(alpha).setStroke()
        let p = NSBezierPath()
        p.appendArc(withCenter: NSPoint(x: cx, y: cy), radius: s * r, startAngle: -52, endAngle: 52)
        p.lineWidth = s * 0.048
        p.lineCapStyle = .round
        p.stroke()
    }
    return img
}

func writePNG(_ image: NSImage, px: Int, to url: URL) {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let target = NSRect(x: 0, y: 0, width: px, height: px)
    image.draw(in: target, from: NSRect(origin: .zero, size: image.size), operation: .copy, fraction: 1)
    NSGraphicsContext.restoreGraphicsState()
    try? rep.representation(using: .png, properties: [:])?.write(to: url)
}

let iconset = URL(fileURLWithPath: outDir).appendingPathComponent("Echo.iconset")
try? FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
let master = drawIcon(size: 1024)
for px in sizes {
    let name = px <= 512 ? "icon_\(px)x\(px).png" : "icon_512x512@2x.png"
    writePNG(master, px: px, to: iconset.appendingPathComponent(name))
    if px <= 512 { writePNG(master, px: px * 2, to: iconset.appendingPathComponent("icon_\(px)x\(px)@2x.png")) }
}
// 菜单栏用的单色模板图（18pt）
let bar = NSImage(size: NSSize(width: 40, height: 40))
bar.lockFocus()
NSColor.black.setFill()
NSBezierPath(ovalIn: NSRect(x: 6, y: 16, width: 9, height: 9)).fill()
for (r, alpha) in [(CGFloat(7.5), 0.95), (13.5, 0.62), (19.5, 0.3)] {
    NSColor.black.withAlphaComponent(alpha).setStroke()
    let p = NSBezierPath()
    p.appendArc(withCenter: NSPoint(x: 9, y: 20), radius: r, startAngle: -52, endAngle: 52)
    p.lineWidth = 3.2
    p.lineCapStyle = .round
    p.stroke()
}
bar.unlockFocus()
writePNG(bar, px: 40, to: URL(fileURLWithPath: outDir).appendingPathComponent("menubar-template.png"))
print("icon set written to \(iconset.path)")