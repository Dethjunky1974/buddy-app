import AppKit
import Foundation

final class BuddyApp: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem?
    private let url = URL(string: "http://127.0.0.1:4317/")!
    private var opened = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = ghostMenuIcon()
        item.button?.toolTip = "Buddy"
        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "Open Buddy", action: #selector(openBuddy), keyEquivalent: "o"))
        menu.addItem(NSMenuItem(title: "Restart Buddy server", action: #selector(restartServer), keyEquivalent: "r"))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit Buddy icon", action: #selector(quit), keyEquivalent: "q"))
        menu.items.forEach { $0.target = self }
        item.menu = menu
        statusItem = item
        openWhenReady(attempt: 0)
    }

    private func ghostMenuIcon() -> NSImage {
        let image = NSImage(size: NSSize(width: 18, height: 18))
        image.lockFocus()
        NSColor.black.setFill()
        let ghost = NSBezierPath()
        ghost.move(to: NSPoint(x: 2, y: 3))
        ghost.curve(to: NSPoint(x: 4, y: 11), controlPoint1: NSPoint(x: 3, y: 5), controlPoint2: NSPoint(x: 3, y: 9))
        ghost.curve(to: NSPoint(x: 9, y: 17), controlPoint1: NSPoint(x: 5, y: 15), controlPoint2: NSPoint(x: 7, y: 17))
        ghost.curve(to: NSPoint(x: 14, y: 11), controlPoint1: NSPoint(x: 11, y: 17), controlPoint2: NSPoint(x: 13, y: 15))
        ghost.curve(to: NSPoint(x: 16, y: 3), controlPoint1: NSPoint(x: 15, y: 9), controlPoint2: NSPoint(x: 15, y: 5))
        ghost.curve(to: NSPoint(x: 13, y: 2), controlPoint1: NSPoint(x: 16, y: 1), controlPoint2: NSPoint(x: 14, y: 3))
        ghost.curve(to: NSPoint(x: 9, y: 2), controlPoint1: NSPoint(x: 12, y: 1), controlPoint2: NSPoint(x: 11, y: 3))
        ghost.curve(to: NSPoint(x: 5, y: 2), controlPoint1: NSPoint(x: 7, y: 3), controlPoint2: NSPoint(x: 6, y: 1))
        ghost.curve(to: NSPoint(x: 2, y: 3), controlPoint1: NSPoint(x: 4, y: 3), controlPoint2: NSPoint(x: 2, y: 1))
        ghost.close()
        ghost.appendOval(in: NSRect(x: 6, y: 9, width: 1.7, height: 3.5))
        ghost.appendOval(in: NSRect(x: 10.3, y: 9, width: 1.7, height: 3.5))
        ghost.windingRule = .evenOdd
        ghost.fill()
        image.unlockFocus()
        image.isTemplate = true
        return image
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        openBuddy()
        return true
    }

    @objc private func openBuddy() {
        openWhenReady(attempt: 0)
    }

    @objc private func restartServer() {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = ["kickstart", "-k", "gui/\(getuid())/app.buddy.local.server"]
        try? process.run()
        openWhenReady(attempt: 0)
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }

    private func openWhenReady(attempt: Int) {
        var request = URLRequest(url: url)
        request.timeoutInterval = 2
        URLSession.shared.dataTask(with: request) { _, response, _ in
            DispatchQueue.main.async {
                if (response as? HTTPURLResponse)?.statusCode == 200 {
                    NSWorkspace.shared.open(self.url)
                    self.opened = true
                } else if attempt < 30 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                        self.openWhenReady(attempt: attempt + 1)
                    }
                } else if !self.opened {
                    let alert = NSAlert()
                    alert.messageText = "Buddy could not start"
                    alert.informativeText = "Choose Restart Buddy server from the menu bar icon. If it still fails, check ~/Library/Application Support/Buddy/server.err.log."
                    alert.runModal()
                }
            }
        }.resume()
    }
}

let app = NSApplication.shared
let delegate = BuddyApp()
app.delegate = delegate
app.run()
