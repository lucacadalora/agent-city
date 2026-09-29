// Agent City: shows the wallpaper page behind the desktop icons on every screen and Space,
// starts the local state server, and adds a small menu-bar item to control it.
import Cocoa
import WebKit

let info = Bundle.main.infoDictionary ?? [:]
let nodePath = info["AgentCityNode"] as? String ?? "/opt/homebrew/bin/node"
let rootPath = (Bundle.main.resourcePath ?? "") + "/app"   // server.mjs, public/ and three.js live in the bundle
let baseURL = URL(string: "http://127.0.0.1:4545/")!

// A borderless window that keeps exactly the frame it is given (no tiling margins,
// never becomes key), so the wallpaper always covers the whole screen.
final class DesktopWindow: NSWindow {
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

// Keeps the real macOS desktop picture set to a still of the city. Whenever the live window
// isn't showing (a rebuild or restart, before login finishes, Mission Control, a Space switch),
// macOS shows that still instead of the stock wallpaper.
enum Still {
    static let dir: URL = {
        let d = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("AgentCity", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }()
    static func key(_ screen: NSScreen) -> String { "originalWallpaper.\(screen.localizedName)" }

    static func apply(_ url: URL, to screen: NSScreen) {
        let ws = NSWorkspace.shared
        guard let current = ws.desktopImageURL(for: screen), current != url else { return }
        // Remember the user's own picture once, for "Quit and Restore Original Wallpaper".
        if !current.path.hasPrefix(dir.path), UserDefaults.standard.string(forKey: key(screen)) == nil {
            UserDefaults.standard.set(current.path, forKey: key(screen))
        }
        try? ws.setDesktopImageURL(url, for: screen, options: [
            .imageScaling: NSImageScaling.scaleProportionallyUpOrDown.rawValue, .allowClipping: true])
    }

    static func restore() {
        for screen in NSScreen.screens {
            guard let path = UserDefaults.standard.string(forKey: key(screen)) else { continue }
            try? NSWorkspace.shared.setDesktopImageURL(URL(fileURLWithPath: path), for: screen, options: [:])
            UserDefaults.standard.removeObject(forKey: key(screen))
        }
    }
}

final class Wallpaper: NSObject, WKNavigationDelegate {
    let window: NSWindow
    let web: WKWebView
    let url: URL
    let screen: NSScreen
    let index: Int
    private var still: URL?
    private var stillTimer: Timer?

    init(screen: NSScreen, index: Int, demo: Bool, saver: Bool, sound: Bool) {
        self.screen = screen
        self.index = index
        let frame = screen.frame
        window = DesktopWindow(contentRect: frame, styleMask: .borderless, backing: .buffered, defer: false)
        window.setFrame(frame, display: false)
        window.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.desktopWindow)))
        window.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenNone]
        window.ignoresMouseEvents = true                  // clicks fall through to the desktop
        window.isReleasedWhenClosed = false
        window.hasShadow = false
        window.backgroundColor = NSColor(srgbRed: 0.10, green: 0.09, blue: 0.10, alpha: 1)

        // Keep the HUD clear of the Dock when it is pinned to the bottom.
        let dock = max(0, screen.visibleFrame.minY - frame.minY)
        var comps = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        comps.queryItems = [URLQueryItem(name: "dock", value: String(Int(dock))),
                            URLQueryItem(name: "screen", value: String(index))]
            + (demo ? [URLQueryItem(name: "demo", value: "1")] : [])
            + (saver ? [URLQueryItem(name: "fps", value: "30")] : [])
            + (sound ? [URLQueryItem(name: "sound", value: "1")] : [])
        url = comps.url!

        // macOS treats desktop-level windows as covered by the desktop-icon layer, so WebKit
        // would pause the page. Turn off occlusion and hidden-page throttling for this view.
        // (Passing nil to these BOOL setters means NO.) The page itself stops drawing at rest.
        let config = WKWebViewConfiguration()
        config.mediaTypesRequiringUserActionForPlayback = []   // meteor sounds; the wallpaper never gets a click
        for sel in ["_setPageVisibilityBasedProcessSuppressionEnabled:", "_setHiddenPageDOMTimerThrottlingEnabled:"]
        where config.preferences.responds(to: NSSelectorFromString(sel)) {
            config.preferences.perform(NSSelectorFromString(sel), with: nil)
        }
        web = WKWebView(frame: NSRect(origin: .zero, size: frame.size), configuration: config)
        let occlusion = NSSelectorFromString("_setWindowOcclusionDetectionEnabled:")
        if web.responds(to: occlusion) { web.perform(occlusion, with: nil) }
        web.autoresizingMask = [.width, .height]
        web.alphaValue = 0                                // fade in once the page has painted
        super.init()
        web.navigationDelegate = self
        window.contentView = web
        window.orderFront(nil)
        window.setFrame(frame, display: true)
        web.load(URLRequest(url: url))
        target = frame
        fit()
        fitTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.fit() }
    }

    // Stage Manager shrinks windows it manages by a fixed margin, even at desktop level.
    // Measure what the window server actually shows and oversize the window to cancel it.
    private var target = NSRect.zero
    private var extra = CGSize.zero
    private var fitTimer: Timer?

    private func serverBounds() -> CGRect? {
        guard let list = CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(window.windowNumber)) as? [[String: Any]],
              let b = list.first?[kCGWindowBounds as String] as? [String: CGFloat] else { return nil }
        return CGRect(x: b["X"] ?? 0, y: b["Y"] ?? 0, width: b["Width"] ?? 0, height: b["Height"] ?? 0)
    }

    private func fit(attempt: Int = 0) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
            guard let self, let b = self.serverBounds() else { return }
            let missW = self.target.width - b.width, missH = self.target.height - b.height
            guard abs(missW) > 0.5 || abs(missH) > 0.5 else { return }
            self.extra.width += missW
            self.extra.height += missH
            self.window.setFrame(self.target.insetBy(dx: -self.extra.width / 2, dy: -self.extra.height / 2), display: true)
            if attempt < 4 { self.fit(attempt: attempt + 1) }
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.8
                webView.animator().alphaValue = 1
            }
        }
        // Refresh the desktop-picture still once the city has settled, then every 20 minutes.
        stillTimer?.invalidate()
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in self?.captureStill() }
        stillTimer = Timer.scheduledTimer(withTimeInterval: 20 * 60, repeats: true) { [weak self] _ in self?.captureStill() }
    }

    private func captureStill() {
        guard url.query?.contains("demo=1") != true else { return }
        web.evaluateJavaScript("window.__snap ? window.__snap() : null") { [weak self] result, _ in
            guard let self, let s = result as? String, let comma = s.firstIndex(of: ","),
                  let png = Data(base64Encoded: String(s[s.index(after: comma)...])), png.count > 20_000 else { return }
            // Alternate two files: macOS caches desktop pictures by path, and other Spaces may
            // still point at the previous one, so it must keep existing.
            let inUse = NSWorkspace.shared.desktopImageURL(for: self.screen)?.lastPathComponent ?? ""
            let file = Still.dir.appendingPathComponent("city-\(self.index)-\(inUse.hasSuffix("-a.png") ? "b" : "a").png")
            guard (try? png.write(to: file, options: .atomic)) != nil else { return }
            self.still = file
            Still.apply(file, to: self.screen)
        }
    }

    // Each Space has its own desktop picture; set the still on a Space the first time it shows.
    func applyStill() { if let still { Still.apply(still, to: screen) } }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { retry() }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { retry() }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { retry() }

    private func retry() {                                // the server may still be starting
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            guard let self else { return }
            self.web.load(URLRequest(url: self.url))
        }
    }

    func reload() { web.load(URLRequest(url: url)) }
    func close() {
        fitTimer?.invalidate()
        stillTimer?.invalidate()
        // Unload the page first: the web view can outlive its closed window, and the page would
        // keep polling the server in the background (frozen, since nothing draws it).
        web.navigationDelegate = nil
        web.stopLoading()
        web.loadHTMLString("", baseURL: nil)
        window.orderOut(nil)
        window.close()
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    var walls: [Wallpaper] = []
    var server: Process?
    var statusItem: NSStatusItem!
    var demoItem: NSMenuItem!
    var saverItem: NSMenuItem!
    var soundItem: NSMenuItem!
    var demo = false
    var saver = UserDefaults.standard.bool(forKey: "batterySaver")
    var sound = UserDefaults.standard.object(forKey: "sound") as? Bool ?? true
    var quitting = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        startServer()
        buildWindows()
        NotificationCenter.default.addObserver(self, selector: #selector(screensChanged),
                                               name: NSApplication.didChangeScreenParametersNotification, object: nil)
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(spaceChanged),
                                                          name: NSWorkspace.activeSpaceDidChangeNotification, object: nil)
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.image = NSImage(systemSymbolName: "building.2.fill", accessibilityDescription: "Agent City")
        let menu = NSMenu()
        menu.addItem(withTitle: "Agent City", action: nil, keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Reload Wallpaper", action: #selector(reload), keyEquivalent: "r").target = self
        demoItem = menu.addItem(withTitle: "Demo Mode", action: #selector(toggleDemo), keyEquivalent: "d")
        demoItem.target = self
        saverItem = menu.addItem(withTitle: "Battery Saver (30 fps)", action: #selector(toggleSaver), keyEquivalent: "")
        saverItem.target = self
        saverItem.state = saver ? .on : .off
        soundItem = menu.addItem(withTitle: "Sound", action: #selector(toggleSound), keyEquivalent: "")
        soundItem.target = self
        soundItem.state = sound ? .on : .off
        menu.addItem(withTitle: "Open in Browser", action: #selector(openInBrowser), keyEquivalent: "").target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit Agent City", action: #selector(quit), keyEquivalent: "q").target = self
        menu.addItem(withTitle: "Quit and Restore Original Wallpaper", action: #selector(quitAndRestore), keyEquivalent: "").target = self
        statusItem.menu = menu
    }

    func startServer() {
        guard !rootPath.isEmpty else { return }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: nodePath)
        p.arguments = [rootPath + "/server.mjs"]
        p.currentDirectoryURL = URL(fileURLWithPath: rootPath)
        var env = ProcessInfo.processInfo.environment
        env["AGENT_CITY_PARENT"] = String(ProcessInfo.processInfo.processIdentifier)
        p.environment = env
        let log = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/AgentCity.log")
        if !FileManager.default.fileExists(atPath: log.path) { FileManager.default.createFile(atPath: log.path, contents: nil) }
        if let handle = try? FileHandle(forWritingTo: log) {
            handle.seekToEndOfFile()                      // keep earlier runs, so a crash's reason survives the restart
            p.standardOutput = handle
            p.standardError = handle
        }
        // If node exits (a crash, or the port still held by a previous copy), start it again.
        p.terminationHandler = { [weak self] _ in
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                guard let self, !self.quitting else { return }
                self.startServer()
            }
        }
        do { try p.run(); server = p } catch { NSLog("Agent City: could not start node: \(error)") }
    }

    func buildWindows() {
        walls.forEach { $0.close() }
        // Only the main screen plays sound, so a second display doesn't double every hit.
        walls = NSScreen.screens.enumerated().map {
            Wallpaper(screen: $0.element, index: $0.offset, demo: demo, saver: saver, sound: sound && $0.offset == 0)
        }
    }

    @objc func screensChanged() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.buildWindows() }
    }
    @objc func reload() { walls.forEach { $0.reload() } }
    @objc func toggleDemo() {
        demo.toggle()
        demoItem.state = demo ? .on : .off
        buildWindows()
    }
    @objc func toggleSaver() {
        saver.toggle()
        UserDefaults.standard.set(saver, forKey: "batterySaver")
        saverItem.state = saver ? .on : .off
        buildWindows()
    }
    @objc func toggleSound() {
        sound.toggle()
        UserDefaults.standard.set(sound, forKey: "sound")
        soundItem.state = sound ? .on : .off
        buildWindows()
    }
    @objc func openInBrowser() { NSWorkspace.shared.open(baseURL) }
    @objc func spaceChanged() { walls.forEach { $0.applyStill() } }
    @objc func quit() { NSApp.terminate(nil) }
    @objc func quitAndRestore() {
        Still.restore()
        NSApp.terminate(nil)
    }

    func applicationWillTerminate(_ notification: Notification) {
        quitting = true
        server?.terminate()
        walls.forEach { $0.close() }
    }
}

// One copy at a time: launchd (see build.sh) and a manual `open` can both start it.
let lockFD = open(Still.dir.appendingPathComponent("instance.lock").path, O_CREAT | O_RDWR, 0o644)
if lockFD < 0 || flock(lockFD, LOCK_EX | LOCK_NB) != 0 { exit(0) }

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)                       // menu-bar only, no Dock icon
app.run()
