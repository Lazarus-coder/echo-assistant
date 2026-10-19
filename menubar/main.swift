import AppKit
import Darwin

// 程序入口：多文件编译时，顶层语句只允许出现在 main.swift 里
// launchd 会把 stdout 重定向到文件，默认块缓冲会让日志迟迟不落盘
setbuf(stdout, nil)
setbuf(stderr, nil)

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let controller = Controller()
app.delegate = controller
app.run()