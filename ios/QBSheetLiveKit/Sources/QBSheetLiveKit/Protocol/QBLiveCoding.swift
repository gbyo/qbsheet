import Foundation

/// JSON coding for QBLive documents.
///
/// The one thing that needs care is dates. QBLive timestamps always carry an explicit offset —
/// `2026-09-05T13:30:00-04:00` — and may or may not carry fractional seconds, because a Director
/// publishing from JavaScript emits milliseconds and a hand-written server may not.
/// `ISO8601DateFormatter` has to be told which of those to expect, so both are tried.
public enum QBLiveCoding {
    public static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let raw = try decoder.singleValueContainer().decode(String.self)
            guard let date = parseTimestamp(raw) else {
                throw DecodingError.dataCorrupted(
                    .init(
                        codingPath: decoder.codingPath,
                        debugDescription: "Not an ISO 8601 timestamp with an offset: \(raw)"
                    )
                )
            }
            return date
        }
        return decoder
    }()

    public static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(withFraction.string(from: date))
        }
        return encoder
    }()

    /// `ISO8601DateFormatter` is not `Sendable`, but these two are configured once at
    /// initialisation and then only ever have `date(from:)` and `string(from:)` called on them.
    /// Both are documented as safe to call concurrently on an unmutated formatter, and the
    /// alternative — a lock around every timestamp in a 500-row statistics table — would be
    /// measurable on a phone. The `nonisolated(unsafe)` is the assertion that nothing mutates them
    /// after the closure returns, which is visible in the twenty lines below.
    nonisolated(unsafe) private static let withFraction: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    nonisolated(unsafe) private static let withoutFraction: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    /// Parse a QBLive timestamp.
    ///
    /// A bare local time is rejected rather than assumed to be UTC. An unqualified "13:30" published
    /// by one server and read by a phone in another zone is exactly the bug the tournament timezone
    /// exists to prevent, and silently guessing would hide it.
    public static func parseTimestamp(_ raw: String) -> Date? {
        withFraction.date(from: raw) ?? withoutFraction.date(from: raw)
    }
}
