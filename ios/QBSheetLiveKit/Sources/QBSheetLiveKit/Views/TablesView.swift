import SwiftUI

/// Standings and statistics, rendered without understanding them.
///
/// The client knows how to align a number, how to highlight a followed row, and how to fall back to
/// the server's `display` string for a column kind it has never met. Adding a statistic in Director
/// makes it appear here with no change to this file. See `docs/QBLIVE.md#10-dynamic-tables`.
///
/// A `Grid` rather than a `Table`: `Table` on iOS collapses to a list, and a standings table is
/// something people read across. Horizontal scrolling with a pinned first column is what the paper
/// version does too.
struct TablesView: View {
    let tables: [QBLiveDataTable]
    let followedTeamId: String?
    let selectedPlayerId: String?

    @State private var scope: String = "overall"

    var body: some View {
        if tables.isEmpty {
            ContentUnavailableView(
                "Nothing published yet",
                systemImage: "list.number",
                description: Text("These appear once the tournament publishes them.")
            )
        } else {
            VStack(alignment: .leading, spacing: 20) {
                if scopes.count > 1 {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(scopes, id: \.id) { entry in
                                Button {
                                    scope = entry.id
                                } label: {
                                    Text(entry.label)
                                        .font(.subheadline)
                                }
                                .buttonStyle(.bordered)
                                .tint(entry.id == effectiveScope ? .accentColor : .secondary)
                                .accessibilityAddTraits(entry.id == effectiveScope ? [.isSelected] : [])
                            }
                        }
                        .padding(.horizontal, 1)
                    }
                }
                ForEach(titles, id: \.self) { title in
                    let forTitle = tables.filter { $0.title == title }
                    if let table = forTitle.first(where: { $0.scope == effectiveScope }) ?? forTitle.first {
                        Section {
                            DataTableView(
                                table: table,
                                followedTeamId: followedTeamId,
                                selectedPlayerId: selectedPlayerId
                            )
                        } header: {
                            SectionHeader(title)
                        }
                    }
                }
            }
        }
    }

    private struct ScopeEntry: Identifiable {
        let id: String
        let label: String
    }

    private var scopes: [ScopeEntry] {
        var seen = Set<String>()
        return tables.compactMap { table in
            guard seen.insert(table.scope).inserted else { return nil }
            return ScopeEntry(id: table.scope, label: table.scopeLabel ?? table.scope)
        }
    }

    /// The selected scope, or the first one the server actually published.
    private var effectiveScope: String {
        scopes.contains { $0.id == scope } ? scope : (scopes.first?.id ?? scope)
    }

    private var titles: [String] {
        var seen = Set<String>()
        return tables.compactMap { seen.insert($0.title).inserted ? $0.title : nil }
    }
}

struct DataTableView: View {
    let table: QBLiveDataTable
    let followedTeamId: String?
    let selectedPlayerId: String?

    var body: some View {
        if table.rows.isEmpty {
            Text("No rows yet.")
                .foregroundStyle(.secondary)
                .padding(.vertical, 8)
        } else {
            ScrollView(.horizontal, showsIndicators: true) {
                Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 0) {
                    GridRow {
                        ForEach(table.columns) { column in
                            Text(column.label)
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                                .gridColumnAlignment(alignment(of: column))
                                .accessibilityLabel(column.description ?? column.label)
                        }
                    }
                    .padding(.vertical, 8)
                    Divider().gridCellUnsizedAxes(.horizontal)
                    ForEach(table.rows) { row in
                        GridRow {
                            ForEach(Array(row.cells.enumerated()), id: \.offset) { index, cell in
                                let column = index < table.columns.count ? table.columns[index] : nil
                                Text(cell.text(precision: column?.precision))
                                    .monospacedDigit()
                                    .gridColumnAlignment(column.map(alignment(of:)) ?? .leading)
                            }
                        }
                        .fontWeight(isHighlighted(row) ? .semibold : .regular)
                        .padding(.vertical, 7)
                        .accessibilityElement(children: .combine)
                        .accessibilityLabel(accessibilityLabel(for: row))
                        Divider().gridCellUnsizedAxes(.horizontal)
                    }
                }
                .padding(.horizontal, 16)
            }
            .background(.background.secondary, in: RoundedRectangle(cornerRadius: 12))
        }
    }

    private func alignment(of column: QBLiveColumn) -> HorizontalAlignment {
        switch column.alignment {
        case .trailing: .trailing
        case .center: .center
        // An unknown kind falls through to leading, which is safe for arbitrary text.
        case .leading, nil: column.kind.isNumeric ? .trailing : .leading
        }
    }

    private func isHighlighted(_ row: QBLiveRow) -> Bool {
        (row.teamId != nil && row.teamId == followedTeamId)
            || (row.playerId != nil && row.playerId == selectedPlayerId)
    }

    /// One spoken sentence per row: "Ninety Six A, rank 1, record 7 and 1".
    ///
    /// Built from the column labels the server supplied, so a new statistic is announced correctly
    /// without this file knowing what it is.
    private func accessibilityLabel(for row: QBLiveRow) -> String {
        zip(table.columns, row.cells)
            .map { column, cell in "\(column.label) \(cell.text(precision: column.precision))" }
            .joined(separator: ", ")
    }
}
