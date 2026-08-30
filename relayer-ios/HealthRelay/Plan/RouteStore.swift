// Route files for the ride card's map preview. The daemon serves GPX files
// from its routes directory (GET /route?file=); the phone parses the track
// points and draws a polyline. Preview only: the head unit does navigation.
// Elevation is deliberately NOT read: a planned-route GPX carries modelled
// terrain that missed every wall on the last century, so a profile drawn
// from it would mislead.

import CoreLocation
import Foundation

struct Route {
    let name: String
    let coordinates: [CLLocationCoordinate2D]
    /// Track length in km, summed point to point.
    let km: Double

    var start: CLLocationCoordinate2D? { coordinates.first }
    var finish: CLLocationCoordinate2D? { coordinates.last }
}

final class RouteStore: ObservableObject {
    enum Status { case idle, loading, failed }

    @Published private(set) var routes: [String: Route] = [:]
    @Published private(set) var statuses: [String: Status] = [:]

    func route(for file: String?) -> Route? {
        guard let file = file else { return nil }
        return routes[file]
    }

    func status(for file: String) -> Status {
        statuses[file] ?? .idle
    }

    /// Fetch (or, under HR_DEMO, read from the HR_DEMO_ROUTE path) a route.
    /// A failure is never sticky: the tailnet is often not up yet at 05:00
    /// when the cached plan first renders, so every foreground, plan change
    /// and pull-to-refresh may try again (`retry`); a plain call only
    /// starts a fetch that has not been attempted yet.
    /// `name` is the plan's label for the route and wins over the file's
    /// own <name> and the bare filename.
    func load(file: String?, name: String? = nil, retry: Bool = false) {
        guard let file = file, !file.isEmpty, routes[file] == nil else { return }
        switch status(for: file) {
        case .loading: return
        case .failed where !retry: return
        default: break
        }
        statuses[file] = .loading
        let label = (name?.isEmpty == false) ? name! : nil
        if Demo.active {
            if let path = ProcessInfo.processInfo.environment["HR_DEMO_ROUTE"],
               let data = FileManager.default.contents(atPath: path) {
                finish(file: file, data: data, name: label)
            } else {
                finish(file: file, data: nil, name: label)
            }
            return
        }
        // Not configured yet (first-run sheet still open): nothing to fetch,
        // and nothing to remember as a failure either.
        guard let url = Settings.shared.routeURL(file: file) else {
            statuses[file] = .idle
            return
        }
        URLSession.shared.dataTask(with: url) { [weak self] data, response, _ in
            let ok = (response as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async {
                self?.finish(file: file, data: ok ? data : nil, name: label)
            }
        }.resume()
    }

    private func finish(file: String, data: Data?, name: String?) {
        if let data = data, let route = GPX.parse(data, preferredName: name, fallbackName: file) {
            routes[file] = route
            statuses[file] = .idle
        } else {
            statuses[file] = .failed
        }
    }
}

/// Minimal GPX reader: every <trkpt>/<rtept> lat/lon in document order, plus
/// the first <name>. Foundation's XMLParser, no dependencies.
enum GPX {
    static func parse(_ data: Data, preferredName: String? = nil, fallbackName: String) -> Route? {
        let reader = Reader()
        let parser = XMLParser(data: data)
        parser.delegate = reader
        guard parser.parse(), reader.points.count >= 2 else { return nil }
        var km = 0.0
        for i in 1..<reader.points.count {
            let a = CLLocation(latitude: reader.points[i - 1].latitude, longitude: reader.points[i - 1].longitude)
            let b = CLLocation(latitude: reader.points[i].latitude, longitude: reader.points[i].longitude)
            km += b.distance(from: a) / 1000
        }
        let fileName = reader.name?.trimmingCharacters(in: .whitespacesAndNewlines)
        let name = preferredName ?? (fileName?.isEmpty == false ? fileName! : fallbackName)
        return Route(name: name, coordinates: reader.points, km: km)
    }

    private final class Reader: NSObject, XMLParserDelegate {
        var points: [CLLocationCoordinate2D] = []
        var name: String?
        private var inName = false
        private var nameBuffer = ""

        func parser(_ parser: XMLParser, didStartElement element: String, namespaceURI: String?,
                    qualifiedName: String?, attributes: [String: String]) {
            switch element {
            case "trkpt", "rtept":
                if let la = attributes["lat"].flatMap(Double.init),
                   let lo = attributes["lon"].flatMap(Double.init) {
                    points.append(CLLocationCoordinate2D(latitude: la, longitude: lo))
                }
            case "name" where name == nil:
                inName = true
                nameBuffer = ""
            default:
                break
            }
        }

        func parser(_ parser: XMLParser, foundCharacters string: String) {
            if inName { nameBuffer += string }
        }

        func parser(_ parser: XMLParser, didEndElement element: String, namespaceURI: String?,
                    qualifiedName: String?) {
            if element == "name", inName {
                inName = false
                if name == nil { name = nameBuffer }
            }
        }
    }
}
