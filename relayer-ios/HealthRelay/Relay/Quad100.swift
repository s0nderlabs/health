// Ask Tailscale's in-tunnel resolver (100.100.100.100) for the Mac's tailnet
// IPv4, bypassing the system resolver (and so iCloud Private Relay / DoH /
// Connectivity Assist). Feeds Settings.tailnetIP for the DNS-free tunnel.

import Foundation
import Network

enum Quad100 {
    static let server = IPv4Address("100.100.100.100")!

    /// One A query over UDP. `completion` runs exactly once on `queue`,
    /// with nil on timeout, NXDOMAIN, no answer, or an answer outside
    /// 100.64.0.0/10.
    static func lookupA(_ name: String, timeout: TimeInterval = 2,
                        queue: DispatchQueue = .main,
                        completion: @escaping (IPv4Address?) -> Void) {
        guard let query = buildQuery(name) else { queue.async { completion(nil) }; return }
        let id = query.id
        let conn = NWConnection(host: .ipv4(server), port: 53, using: .udp)
        var done = false
        func finish(_ ip: IPv4Address?) {
            guard !done else { return }
            done = true
            conn.stateUpdateHandler = nil
            conn.cancel()
            completion(ip)
        }
        conn.stateUpdateHandler = { state in
            switch state {
            case .ready:
                conn.send(content: query.bytes, completion: .contentProcessed { if $0 != nil { finish(nil) } })
                conn.receiveMessage { data, _, _, _ in finish(data.flatMap { parseA($0, id: id) }) }
            case .waiting, .failed:
                finish(nil)
            default:
                break
            }
        }
        conn.start(queue: queue)
        queue.asyncAfter(deadline: .now() + timeout) { finish(nil) }
    }

    /// The whole learn step: ask quad-100 for `host`'s name, then verify the
    /// answer through the tunnel (TailnetTunnel.verify) before handing it
    /// back. An answer equal to `known` skips the probe (nothing would
    /// change). `completion` runs once on main: the verified IP string, or nil.
    static func discover(host: String, known: String = "",
                         completion: @escaping (String?) -> Void) {
        guard let name = Settings.hostName(host) else {
            DispatchQueue.main.async { completion(nil) }
            return
        }
        lookupA(name) { ip in
            guard let ip = ip else { return completion(nil) }
            let found = "\(ip)"
            if found == known { return completion(found) }
            TailnetTunnel.verify(host: host, ip: ip) { ok in
                if !ok { rlog("tailnet IP from Tailscale DNS failed the /healthz check; not stored") }
                completion(ok ? found : nil)
            }
        }
    }

    static func buildQuery(_ name: String) -> (id: UInt16, bytes: Data)? {
        let id = UInt16.random(in: 1...UInt16.max)
        var q = Data([UInt8(id >> 8), UInt8(id & 0xff), 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0])
        for label in name.split(separator: ".") {
            let bytes = Array(label.utf8)
            guard !bytes.isEmpty, bytes.count < 64 else { return nil }
            q.append(UInt8(bytes.count))
            q.append(contentsOf: bytes)
        }
        q.append(contentsOf: [0, 0, 1, 0, 1]) // root label, QTYPE=A, QCLASS=IN
        return (id, q)
    }

    static func parseA(_ d: Data, id: UInt16) -> IPv4Address? {
        let b = [UInt8](d)
        guard b.count >= 12, (UInt16(b[0]) << 8 | UInt16(b[1])) == id,
              b[2] & 0x80 != 0, b[3] & 0x0f == 0 else { return nil } // QR set, RCODE 0
        let qd = Int(b[4]) << 8 | Int(b[5]), an = Int(b[6]) << 8 | Int(b[7])
        var i = 12
        func skipName() -> Bool {
            while i < b.count {
                let l = Int(b[i])
                if l == 0 { i += 1; return true }
                if l & 0xC0 == 0xC0 { i += 2; return true }
                i += 1 + l
            }
            return false
        }
        for _ in 0..<qd { guard skipName() else { return nil }; i += 4 }
        for _ in 0..<an {
            guard skipName(), i + 10 <= b.count else { return nil }
            let type = Int(b[i]) << 8 | Int(b[i + 1]), cls = Int(b[i + 2]) << 8 | Int(b[i + 3])
            let len = Int(b[i + 8]) << 8 | Int(b[i + 9])
            i += 10
            guard i + len <= b.count else { return nil }
            if type == 1, cls == 1, len == 4, let a = IPv4Address(Data(b[i..<i + 4])),
               TailnetTunnel.Route.isTailnet(a) { return a } // 100.64.0.0/10 only
            i += len
        }
        return nil
    }
}
