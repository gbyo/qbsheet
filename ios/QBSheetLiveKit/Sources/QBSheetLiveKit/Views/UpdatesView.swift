import SwiftUI

/// Updates: Director announcements.
///
/// `Text(announcement.body)` and nothing else. Never `AttributedString(markdown:)`, never an HTML
/// renderer: this string came from a tournament backend somebody else operates, and rendering a
/// stranger's markup on a few hundred phones is not worth a bold word.
struct UpdatesView: View {
    let snapshot: QBLiveSnapshot
    let teamId: String

    var body: some View {
        let announcements = snapshot.announcements(for: teamId)
        if announcements.isEmpty {
            ContentUnavailableView(
                "No announcements",
                systemImage: "bell",
                description: Text("Tournament updates appear here.")
            )
        } else {
            VStack(alignment: .leading, spacing: 12) {
                ForEach(announcements) { announcement in
                    AnnouncementCard(announcement: announcement, snapshot: snapshot, compact: false)
                }
            }
        }
    }
}

struct AnnouncementCard: View {
    let announcement: QBLiveAnnouncement
    let snapshot: QBLiveSnapshot
    let compact: Bool

    var body: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 4) {
                Text(announcement.title)
                    .font(.headline)
                // Plain text. `.pre-wrap` equivalent: line breaks survive, markup does not.
                Text(announcement.body)
                    .font(.subheadline)
                    .fixedSize(horizontal: false, vertical: true)
                if !compact {
                    Text(footer)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } label: {
            Label(severityWord, systemImage: severitySymbol)
                .foregroundStyle(accent)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(severityWord). \(announcement.title). \(announcement.body)")
    }

    private var accent: Color {
        switch announcement.severity {
        case .urgent: .red
        case .important: .orange
        case .information: .secondary
        }
    }

    private var severitySymbol: String {
        switch announcement.severity {
        case .urgent: "exclamationmark.triangle.fill"
        case .important: "exclamationmark.circle.fill"
        case .information: "info.circle"
        }
    }

    private var severityWord: String {
        switch announcement.severity {
        case .urgent: "Urgent"
        case .important: "Important"
        case .information: "Announcement"
        }
    }

    private var footer: String {
        var parts = [LiveFormat.time(announcement.publishedAt, in: snapshot.tournament.resolvedTimeZone)]
        if !announcement.audienceTeamIds.isEmpty {
            parts.append(announcement.audienceTeamIds.map(snapshot.teamName).joined(separator: ", "))
        }
        if announcement.updatedAt != nil { parts.append("edited") }
        return parts.joined(separator: " · ")
    }
}
