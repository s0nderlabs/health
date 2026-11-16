// DNS-free reach for the daemon with the URLSession code left as it is.
//
// Every request still goes to https://<ts.net name>:8443 or wss://..., so
// URLSession keeps setting SNI, checking the Let's Encrypt cert against that
// name with default trust, running the WebSocket and reporting HTTP statuses
// exactly as before. The only change is that the session is told to reach that
// name through an HTTP CONNECT proxy on 127.0.0.1 inside this app. The proxy
// accepts exactly one authority, "<ts.net name>:<port>", and splices raw TCP to
// the Mac's tailnet IP. Nothing resolves the name, so iCloud Private Relay,
// Connectivity Assist or a DoH app cannot misroute it. TLS stays end to end
// between URLSession and tailscale serve: the proxy only ever carries
// ciphertext and never sees the token. Nothing new is reachable either: every
// app on the phone can already dial the tailnet IP through the Tailscale VPN.

import Foundation
import Network

final class TailnetTunnel {
    static let shared = TailnetTunnel()

    /// How long a listener keeps accepting after its session was built.
    /// URLSession dials the proxy within milliseconds of resume(); connections
    /// a listener accepted outlive its cancel.
    private static let listenerGrace: TimeInterval = 30

    struct Route: Equatable {
        /// What CONNECT must ask for, lower-cased: "<ts.net name>:<port>".
        let authority: String
        /// Proxy match domain: only this host is sent through the tunnel.
        let name: String
        let ip: IPv4Address
        let port: NWEndpoint.Port

        /// The app path. `host` is Settings.host ("name:port", port 443 if
        /// omitted); `ip` is the Mac's tailnet IPv4 (`tailscale ip -4`). nil
        /// unless `ip` is inside 100.64.0.0/10, so a typo can never point the
        /// stream at a public address.
        static func tailnet(host: String, ip: String) -> Route? {
            guard let addr = tailnetAddress(ip),
                  let name = name(of: host),
                  // URLComponents accepts any integer port ("host:84431");
                  // UInt16(_:) would trap on it, so convert exactly.
                  let raw = UInt16(exactly: components(host)?.port ?? 443), raw != 0,
                  let port = NWEndpoint.Port(rawValue: raw)
            else { return nil }
            return Route(authority: "\(name):\(port.rawValue)", name: name, ip: addr, port: port)
        }

        /// The IP check alone (Settings validates the field with it, so a bad
        /// host never gets blamed on a good IP).
        static func isTailnetIP(_ ip: String) -> Bool { tailnetAddress(ip) != nil }

        /// The bare, lower-cased name in "name[:port]", which must contain a
        /// dot. The one parse behind the route, Find and the quad-100 lookup.
        static func name(of host: String) -> String? {
            guard let name = components(host)?.host?.lowercased(), name.contains(".") else { return nil }
            return name
        }

        private static func tailnetAddress(_ ip: String) -> IPv4Address? {
            let ip = ip.trimmingCharacters(in: .whitespaces)
            guard !ip.isEmpty, let addr = IPv4Address(ip), isTailnet(addr) else { return nil }
            return addr
        }

        private static func components(_ host: String) -> URLComponents? {
            URLComponents(string: "https://\(host.trimmingCharacters(in: .whitespaces))")
        }

        static func isTailnet(_ a: IPv4Address) -> Bool {
            let b = [UInt8](a.rawValue)
            return b.count == 4 && b[0] == 100 && (b[1] & 0xC0) == 0x40
        }
    }

    private let queue = DispatchQueue(label: "health.tailnet-tunnel")
    private var links: [ObjectIdentifier: Link] = [:] // touched on `queue` only

    /// The config every daemon session is built from. No route (no tailnet IP
    /// set) = plain .default, i.e. today's hostname path, unchanged.
    func configuration(route: Route?) -> URLSessionConfiguration {
        let cfg = URLSessionConfiguration.default
        guard let route = route else { return cfg }
        guard let port = arm(route) else {
            rlog("tunnel listener unavailable, dialing direct")
            return cfg
        }
        var proxy = ProxyConfiguration(httpCONNECTProxy: .hostPort(host: .ipv4(.loopback), port: port))
        proxy.matchDomains = [route.name]
        cfg.proxyConfigurations = [proxy]
        return cfg
    }

    /// Proves `ip` really is the Mac before anything stores it: GET /healthz
    /// (unauthenticated, no token) through the tunnel with that route, which
    /// only answers 200 if TLS verified the ts.net certificate with default
    /// trust at that address. A spoofed quad-100 answer (Tailscale off, a
    /// carrier CGNAT host) or a stale IP fails here. `completion` on main.
    static func verify(host: String, ip: IPv4Address, completion: @escaping (Bool) -> Void) {
        let done = { (ok: Bool) in DispatchQueue.main.async { completion(ok) } }
        guard let route = Route.tailnet(host: host, ip: "\(ip)"),
              let url = URL(string: "https://\(host.trimmingCharacters(in: .whitespaces))/healthz")
        else { return done(false) }
        let cfg = shared.configuration(route: route)
        // No proxy means the listener failed and this would test the plain
        // hostname path instead of the IP: count it as unverified.
        guard !cfg.proxyConfigurations.isEmpty else { return done(false) }
        cfg.timeoutIntervalForRequest = 12 // the upstream dial alone may take 10
        cfg.timeoutIntervalForResource = 15
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        fetch(url, configuration: cfg) { _, response, _ in
            done((response as? HTTPURLResponse)?.statusCode == 200)
        }
    }

    /// Same as fetch, for a full request (method + body): one task on a
    /// throwaway session, on the route current at call time.
    static func send(_ request: URLRequest, configuration: URLSessionConfiguration,
                     completion: @escaping (Data?, URLResponse?, Error?) -> Void) {
        let session = URLSession(configuration: configuration)
        session.dataTask(with: request, completionHandler: completion).resume()
        session.finishTasksAndInvalidate()
    }

    /// One GET on a throwaway session. Per fetch, never URLSession.shared, so
    /// it takes the route (and a fresh listener) current at call time;
    /// invalidating after resume lets the task finish, then frees the session.
    static func fetch(_ url: URL, configuration: URLSessionConfiguration,
                      completion: @escaping (Data?, URLResponse?, Error?) -> Void) {
        let session = URLSession(configuration: configuration)
        session.dataTask(with: url, completionHandler: completion).resume()
        session.finishTasksAndInvalidate()
    }

    /// One fresh loopback listener per session, the same one-per-attempt rule
    /// SocketLeg keeps for URLSession: iOS can reclaim a listening socket while
    /// the app is suspended without telling it (TN2277), so a long-lived
    /// listener could go deaf; one armed right before the session cannot.
    /// Waits (bounded) for the bind so the port is live before the first dial.
    private func arm(_ route: Route) -> NWEndpoint.Port? {
        let tcp = NWProtocolTCP.Options()
        tcp.noDelay = true
        let params = NWParameters(tls: nil, tcp: tcp)
        params.requiredInterfaceType = .loopback
        params.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
        guard let listener = try? NWListener(using: params) else { return nil }
        let settled = DispatchSemaphore(value: 0)
        var port: NWEndpoint.Port?
        listener.stateUpdateHandler = { [weak listener] state in
            switch state {
            case .ready:
                port = listener?.port
                settled.signal()
            case .failed:
                listener?.cancel()
                settled.signal()
            default:
                break
            }
        }
        listener.newConnectionHandler = { [weak self] conn in self?.accept(conn, route) }
        listener.start(queue: queue)
        guard settled.wait(timeout: .now() + 0.5) == .success, let bound = port else {
            listener.cancel()
            return nil
        }
        queue.asyncAfter(deadline: .now() + Self.listenerGrace) { listener.cancel() }
        return bound
    }

    private final class Link {
        let client: NWConnection
        var upstream: NWConnection?
        var head = Data()
        var spliced = false
        var openDirections = 2
        var done = false
        init(client: NWConnection) { self.client = client }
    }

    private func accept(_ client: NWConnection, _ route: Route) {
        let link = Link(client: client)
        links[ObjectIdentifier(link)] = link
        client.stateUpdateHandler = { [weak self, weak link] state in
            if case .failed = state, let link = link { self?.finish(link) }
        }
        client.start(queue: queue)
        readHead(link, route)
    }

    private func readHead(_ link: Link, _ route: Route) {
        link.client.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] data, _, isComplete, error in
            guard let self = self, !link.done else { return }
            if let data = data { link.head.append(data) }
            if let end = link.head.range(of: Data("\r\n\r\n".utf8)) {
                let line = String(decoding: link.head[link.head.startIndex..<end.lowerBound], as: UTF8.self)
                    .components(separatedBy: "\r\n")[0]
                let parts = line.split(separator: " ")
                guard parts.count == 3, parts[0] == "CONNECT", parts[1].lowercased() == route.authority else {
                    self.reply(link, "403 Forbidden")
                    return
                }
                self.dial(link, route, leftover: Data(link.head[end.upperBound...]))
                return
            }
            if error != nil || isComplete || link.head.count > 8192 { self.finish(link); return }
            self.readHead(link, route)
        }
    }

    private func dial(_ link: Link, _ route: Route, leftover: Data) {
        let tcp = NWProtocolTCP.Options()
        tcp.noDelay = true
        tcp.connectionTimeout = 10
        let up = NWConnection(host: .ipv4(route.ip), port: route.port, using: NWParameters(tls: nil, tcp: tcp))
        link.upstream = up
        up.stateUpdateHandler = { [weak self, weak link] state in
            guard let self = self, let link = link, !link.done else { return }
            switch state {
            case .ready where !link.spliced:
                link.spliced = true
                link.client.send(content: Data("HTTP/1.1 200 Connection Established\r\n\r\n".utf8),
                                 completion: .contentProcessed { _ in })
                if !leftover.isEmpty { up.send(content: leftover, completion: .contentProcessed { _ in }) }
                self.pump(link, from: link.client, to: up)
                self.pump(link, from: up, to: link.client)
            case .waiting, .failed:
                // Not spliced yet: answer so URLSession fails the attempt now
                // (its own error path + SocketLeg's backoff) instead of hanging.
                if link.spliced { self.finish(link) } else { self.reply(link, "502 Bad Gateway") }
            default:
                break
            }
        }
        up.start(queue: queue)
    }

    private func pump(_ link: Link, from: NWConnection, to: NWConnection) {
        from.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, isComplete, error in
            guard let self = self, !link.done else { return }
            if let data = data, !data.isEmpty {
                to.send(content: data, completion: .contentProcessed { [weak self] sendError in
                    guard let self = self, !link.done else { return }
                    if sendError != nil { self.finish(link) }
                    else if isComplete { self.halfClose(link, to) }
                    else { self.pump(link, from: from, to: to) }
                })
            } else if isComplete {
                self.halfClose(link, to)
            } else if error != nil {
                self.finish(link)
            } else {
                self.pump(link, from: from, to: to)
            }
        }
    }

    /// One direction hit EOF: pass the FIN on; both directions done = close.
    private func halfClose(_ link: Link, _ to: NWConnection) {
        to.send(content: nil, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { _ in })
        link.openDirections -= 1
        if link.openDirections == 0 { finish(link) }
    }

    private func reply(_ link: Link, _ status: String) {
        let text = "HTTP/1.1 \(status)\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        link.client.send(content: Data(text.utf8), completion: .contentProcessed { [weak self] _ in
            self?.finish(link)
        })
    }

    private func finish(_ link: Link) {
        guard !link.done else { return }
        link.done = true
        link.client.cancel()
        link.upstream?.cancel()
        links[ObjectIdentifier(link)] = nil
    }
}
