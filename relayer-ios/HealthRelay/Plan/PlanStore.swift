// Today's /gym session plan. Authored by Claude in the user's main session
// (the /gym skill writes plan.json), served by the daemon at GET /plan, and
// pushed here live via the socket's plan_updated message. The phone renders;
// it never computes programming.

import Foundation

struct Plan: Codable {
    struct Amrap: Codable {
        let rir: String?
        let target: String?
    }

    /// One distinct back-off weight. An array because Pana runs 2x6 at one
    /// weight while other days may stack several drop-downs.
    struct Backoff: Codable {
        let weight_kg: Double?
        let sets: String?
        let rest: String?
        let note: String?
    }

    struct Lift: Codable {
        let order: Int?
        let name: String?
        let weight_kg: Double?
        let scheme: String?
        let ladder: String?
        let amrap: Amrap?
        let backoff: [Backoff]?
        let rest: String?
        let notes: String?
    }

    let generated_at: String?
    let date: String?
    let title: String?
    let cycle: Int?
    let week: Int?
    let day: Int?
    let rest: Bool?
    let recovery_note: String?
    let warmup: [String]?
    let lifts: [Lift]?
    let session_notes: [String]?
    let reminders: [String]?
}

enum PlanLines {
    /// The opening pointer for the lock screen: the plan's first lift.
    static func firstLine(_ plan: Plan?) -> String? {
        guard let lift = plan?.lifts?.first else { return nil }
        var parts: [String] = []
        if let name = lift.name { parts.append(name) }
        if let kg = lift.weight_kg, kg > 0 {
            parts.append(kg.truncatingRemainder(dividingBy: 1) == 0
                ? "\(Int(kg)) kg" : String(format: "%.1f kg", kg))
        }
        if let scheme = lift.scheme { parts.append(scheme) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

final class PlanStore: ObservableObject {
    @Published var plan: Plan?
    @Published var fetchedAt: Date?
    @Published var error: String?
    @Published var loading = false

    private static let cacheKey = "plan_cache_v1"

    init() {
        // The gym has the tailnet over cellular, but a cached plan beats a
        // spinner if the link is slow walking in.
        if let data = UserDefaults.standard.data(forKey: Self.cacheKey),
           let cached = try? JSONDecoder().decode(Plan.self, from: data) {
            plan = cached
        }
    }

    func refresh() {
        guard let url = Settings.shared.planURL else { return }
        loading = true
        URLSession.shared.dataTask(with: url) { [weak self] data, response, err in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.loading = false
                if let err = err {
                    self.error = "Plan fetch failed: \(err.localizedDescription)"
                    return
                }
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                guard status == 200, let data = data else {
                    self.error = status == 404
                        ? "No plan yet. Ask for today's plan in your session."
                        : "Plan fetch failed (\(status))."
                    return
                }
                guard let decoded = try? JSONDecoder().decode(Plan.self, from: data) else {
                    self.error = "Plan file did not parse."
                    return
                }
                self.plan = decoded
                self.fetchedAt = Date()
                self.error = nil
                UserDefaults.standard.set(data, forKey: Self.cacheKey)
            }
        }.resume()
    }
}
