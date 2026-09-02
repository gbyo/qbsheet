import Foundation

/// Local storage for QBSheet Live.
///
/// # Why an App Group
///
/// Three processes need this: the full app, the App Clip, and the Live Activity extension. An App
/// Group container is the only place all three can read, and it is also what makes the App Clip →
/// full app transition seamless — Apple migrates the group container, so a spectator who installs
/// the full app after using the Clip finds their team already followed.
///
/// # What is stored
///
/// The last bootstrap, the followed team, the selected player, and the last snapshot per tournament.
/// Nothing here is a credential, because QBSheet Live has none: there is no account to have one for.
public final class LivePersistence: @unchecked Sendable {
    /// Must match the App Group in every target's entitlements. See `docs/QBLIVE_IOS.md`.
    public static let appGroupIdentifier = "group.com.qbsheet.live"

    public static let shared = LivePersistence()

    private let defaults: UserDefaults
    private let cacheDirectory: URL?
    private let queue = DispatchQueue(label: "com.qbsheet.live.persistence")

    public init(suiteName: String? = LivePersistence.appGroupIdentifier) {
        // `UserDefaults(suiteName:)` returns nil when the App Group is not provisioned — a
        // development build, or a target whose entitlement was forgotten. Falling back to
        // `.standard` keeps the app working and loses only the cross-process sharing.
        defaults = suiteName.flatMap(UserDefaults.init(suiteName:)) ?? .standard
        cacheDirectory = suiteName.flatMap {
            FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: $0)
        } ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
    }

    private enum Key {
        static let bootstrap = "qbsheet.live.bootstrap"
        static let followedTeam = "qbsheet.live.followedTeam"
        static let selectedPlayer = "qbsheet.live.selectedPlayer"
        static let notificationsEnabled = "qbsheet.live.notifications"
        static let activityShard = "qbsheet.live.activityShard"
    }

    // MARK: - Bootstrap

    /// The tournament this device last opened.
    ///
    /// Load-bearing for notifications: a tap that reopens the App Clip does not always carry the
    /// original invocation URL, and reopening on a blank screen would be the wrong answer. See
    /// `docs/QBLIVE_IOS.md#app-clip-notifications`.
    public var lastBootstrap: QBLiveBootstrap? {
        get {
            queue.sync {
                guard let data = defaults.data(forKey: Key.bootstrap) else { return nil }
                return try? JSONDecoder().decode(QBLiveBootstrap.self, from: data)
            }
        }
        set {
            queue.sync {
                if let newValue, let data = try? JSONEncoder().encode(newValue) {
                    defaults.set(data, forKey: Key.bootstrap)
                } else {
                    defaults.removeObject(forKey: Key.bootstrap)
                }
            }
        }
    }

    public var followedTeamId: String? {
        get { queue.sync { defaults.string(forKey: Key.followedTeam) } }
        set { queue.sync { defaults.set(newValue, forKey: Key.followedTeam) } }
    }

    public var selectedPlayerId: String? {
        get { queue.sync { defaults.string(forKey: Key.selectedPlayer) } }
        set { queue.sync { defaults.set(newValue, forKey: Key.selectedPlayer) } }
    }

    public var notificationsEnabled: Bool {
        get { queue.sync { defaults.bool(forKey: Key.notificationsEnabled) } }
        set { queue.sync { defaults.set(newValue, forKey: Key.notificationsEnabled) } }
    }

    /// The APNs broadcast channel this device's Live Activity is subscribed to, if any.
    public var activityChannelId: String? {
        get { queue.sync { defaults.string(forKey: Key.activityShard) } }
        set { queue.sync { defaults.set(newValue, forKey: Key.activityShard) } }
    }

    // MARK: - Snapshot cache

    public struct CachedSnapshot: Sendable {
        public let snapshot: QBLiveSnapshot
        public let receivedAt: Date
    }

    private func cacheURL(for publicationId: String) -> URL? {
        // The publication id is validated before it reaches here, so it cannot contain a path
        // separator; the check is kept because this composes a filesystem path from network input.
        guard QBLiveBootstrap.isPublicationId(publicationId), let cacheDirectory else { return nil }
        return cacheDirectory.appendingPathComponent("qblive-\(publicationId).json")
    }

    public func cachedSnapshot(for publicationId: String) -> CachedSnapshot? {
        guard let url = cacheURL(for: publicationId) else { return nil }
        return queue.sync {
            guard let data = try? Data(contentsOf: url),
                  data.count <= QBLiveClient.maximumBodyBytes,
                  // Re-decoded rather than trusted. It was written by this app, but a corrupt file
                  // should degrade to "no cache" rather than to a crash on a gym floor.
                  let snapshot = try? QBLiveCoding.decoder.decode(QBLiveSnapshot.self, from: data)
            else { return nil }
            let modified = (try? FileManager.default.attributesOfItem(atPath: url.path)[.modificationDate]) as? Date
            return CachedSnapshot(snapshot: snapshot, receivedAt: modified ?? Date.distantPast)
        }
    }

    public func cache(_ snapshot: QBLiveSnapshot) {
        guard let url = cacheURL(for: snapshot.publicationId) else { return }
        queue.sync {
            guard let data = try? QBLiveCoding.encoder.encode(snapshot) else { return }
            // Atomic, so a process killed mid-write leaves the previous cache rather than a
            // truncated file. `.completeFileProtectionUnlessOpen` because a Live Activity extension
            // may need to read this while the device is locked.
            try? data.write(to: url, options: [.atomic, .completeFileProtectionUnlessOpen])
        }
    }

    /// Forget a tournament. Used when a publication is deleted and when the user asks.
    public func forget(publicationId: String) {
        guard let url = cacheURL(for: publicationId) else { return }
        queue.sync { try? FileManager.default.removeItem(at: url) }
    }
}
