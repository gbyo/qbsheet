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
        // Announcements can expire without a new snapshot arriving. Let SwiftUI schedule the
        // lightweight time-driven refresh instead of owning another app-level timer or poll loop.
        TimelineView(.periodic(from: .now, by: 30)) { context in
            content(now: context.date)
        }
    }

    @ViewBuilder
    private func content(now: Date) -> some View {
        let announcements = snapshot.announcements(for: teamId, now: now)
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
        VStack(alignment: .leading, spacing: 4) {
            Label {
                Text(announcement.title)
                    .foregroundStyle(.primary)
            } icon: {
                Image(systemName: severitySymbol)
                    .foregroundStyle(accent)
            }
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
        .padding(14)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 12))
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
