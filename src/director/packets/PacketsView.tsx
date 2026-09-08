import { useState } from 'react';
import type { DirectorState } from '../domain';
import type { DirectorController } from '../state/useDirectorController';
import {
  ActionMenu,
  Button,
  Checkbox,
  Diagnostics,
  Dialog,
  EmptyState,
  Field,
  MenuFileItem,
  MenuItem,
  Page,
  PageHeader,
  Panel,
  StateLabel,
  SummaryItem,
  SummaryList,
  TextArea,
  TextInput,
  useConfirm,
} from '../components';
import { importQbjText } from '../format/interchange';
import type { SectionId } from '../app/navigation';
import type { DirectorNavigationTarget } from '../app/navigationTarget';
import { useNavigationHighlight } from '../app/useNavigationHighlight';
import { errorNotice, type AnnounceInput } from '../notices';

type Navigate = (section: SectionId, target?: DirectorNavigationTarget | null) => void;

export function PacketsView({
  state,
  controller,
  onNavigate,
  onAnnounce,
  navigationTarget,
  onClearNavigationTarget,
}: {
  state: DirectorState;
  controller: DirectorController;
  onNavigate?: Navigate;
  onAnnounce: (announcement: AnnounceInput) => void;
  navigationTarget?: DirectorNavigationTarget | null;
  onClearNavigationTarget?: () => void;
}) {
  const [editingPacketId, setEditingPacketId] = useState<string | null | 'new'>(null);

  const importQbj = async (file: File | undefined) => {
    if (!file) return;
    try {
      const report = importQbjText(await file.text());
      if (!report.ok || !report.state) {
        onAnnounce(errorNotice(report.errors.join(' ') || 'That QBJ file is not valid.'));
        return;
      }
      if (report.state.packets.length === 0) {
        onAnnounce(errorNotice('That QBJ file does not contain packet inventory.'));
        return;
      }
      const result = controller.addPackets(
        report.state.packets.map((packet) => ({
          name: packet.name,
          source: 'qbj' as const,
          tiebreaker: packet.tiebreaker,
          notes: packet.notes,
        })),
      );
      onAnnounce(
        `${result.inserted} packet${result.inserted === 1 ? '' : 's'} imported${
          result.skipped ? `; ${result.skipped} duplicate${result.skipped === 1 ? '' : 's'} skipped` : ''
        }.${report.warnings.length ? ` ${report.warnings.length} warning${report.warnings.length === 1 ? '' : 's'} retained.` : ''}`,
      );
    } catch (reason: unknown) {
      onAnnounce(errorNotice(reason instanceof Error ? reason.message : 'That QBJ file could not be read.'));
    }
  };

  const defaultPacket = state.packets.find((packet) => packet.id === state.tournament?.currentPacketId);
  const unusedCount = state.packets.filter(
    (packet) => !packet.retired && packet.usedGameIds.length === 0,
  ).length;

  return (
    <Page>
      <PageHeader
        title="Packets"
        description={`${state.packets.length} packet${state.packets.length === 1 ? '' : 's'} · ${unusedCount} unused${defaultPacket ? ` · ${defaultPacket.name} is the default for newly generated rounds` : ''}`}
        actions={
          <>
            <ActionMenu
              label="Packet import"
              triggerLabel="Import"
              triggerVariant="secondary"
              triggerIcon="upload"
            >
              {(close) => (
                <MenuFileItem
                  accept=".qbj,application/vnd.quizbowl.qbj+json"
                  onFile={(files) => {
                    close();
                    void importQbj(files[0]);
                  }}
                >
                  Import QBJ…
                </MenuFileItem>
              )}
            </ActionMenu>
            <Button variant="primary" icon="plus" onClick={() => setEditingPacketId('new')}>
              Add packet
            </Button>
          </>
        }
      />

      <Panel
        title="Packet defaults"
        description="The default is used only when a newly generated round does not have an explicit packet assignment. Each round can still choose a different packet from Tournament day."
      >
        <p className="director-text-secondary">
          {defaultPacket
            ? `${defaultPacket.name} is currently the default for new rounds.`
            : 'No default packet is selected. New rounds can still receive an explicit packet assignment later.'}
        </p>
      </Panel>

      {state.packets.length === 0 ? (
        <EmptyState
          title="No packets in inventory"
          description="Add packet names now or import QBJ packet data. Director retains assignment and usage history."
        >
          <Button variant="primary" icon="plus" onClick={() => setEditingPacketId('new')}>
            Add first packet
          </Button>
        </EmptyState>
      ) : (
        <Panel title="Inventory" description="Assignment history stays attached to each packet." flush>
          <SummaryList ariaLabel="Packet inventory">
            {state.packets.map((packet) => (
              <PacketItem
                key={packet.id}
                state={state}
                packet={packet}
                controller={controller}
                onNavigate={onNavigate}
                onAnnounce={onAnnounce}
                navigationTarget={navigationTarget}
                onClearNavigationTarget={onClearNavigationTarget}
                onEdit={() => setEditingPacketId(packet.id)}
              />
            ))}
          </SummaryList>
        </Panel>
      )}

      {editingPacketId && (
        <PacketDialog
          key={editingPacketId}
          packet={
            editingPacketId === 'new'
              ? undefined
              : state.packets.find((packet) => packet.id === editingPacketId)
          }
          controller={controller}
          onAnnounce={onAnnounce}
          onClose={() => setEditingPacketId(null)}
        />
      )}
    </Page>
  );
}

function PacketItem({
  state,
  packet,
  controller,
  onNavigate,
  onAnnounce,
  navigationTarget,
  onClearNavigationTarget,
  onEdit,
}: {
  state: DirectorState;
  packet: DirectorState['packets'][number];
  controller: DirectorController;
  onNavigate?: Navigate;
  onAnnounce: (announcement: AnnounceInput) => void;
  navigationTarget?: DirectorNavigationTarget | null;
  onClearNavigationTarget?: () => void;
  onEdit: () => void;
}) {
  const confirmAction = useConfirm();
  const highlighted = useNavigationHighlight(
    navigationTarget,
    'packets',
    'packet',
    packet.id,
    onClearNavigationTarget,
  );
  const isDefault = packet.id === state.tournament?.currentPacketId;
  const usingRounds = packet.assignedRoundIds
    .map((roundId) => state.rounds.find((entry) => entry.id === roundId))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
  const scheduledById = new Map(state.scheduledGames.map((game) => [game.id, game]));
  const recordsById = new Map(state.games.map((game) => [game.id, game]));
  const assignments = packet.assignedGameIds.map((assignmentId) => {
    const scheduled = scheduledById.get(assignmentId);
    const record = recordsById.get(assignmentId);
    const resolvedScheduled = scheduled ?? (record ? scheduledById.get(record.scheduledGameId) : undefined);
    return { assignmentId, scheduled: resolvedScheduled, record };
  });
  const replacement = packet.replacementForPacketId
    ? state.packets.find((entry) => entry.id === packet.replacementForPacketId)
    : undefined;

  return (
    <SummaryItem
      className={highlighted ? 'is-navigation-target' : ''}
      title={
        <strong data-director-navigation-id={packet.id} data-director-navigation-focus tabIndex={-1}>
          {packet.name}
        </strong>
      }
      status={
        <div className="director-actions">
          {isDefault && <StateLabel state="live" label="Default for new rounds" />}
          <StateLabel
            state={packet.retired ? 'archived' : packet.usedGameIds.length > 0 ? 'finished' : 'available'}
            label={packet.retired ? 'Retired' : packet.usedGameIds.length > 0 ? 'Used' : 'Available'}
          />
        </div>
      }
      summary={[
        packet.tiebreaker ? 'Tiebreaker' : null,
        `${packet.assignedRoundIds.length} round assignment${packet.assignedRoundIds.length === 1 ? '' : 's'}`,
        `${packet.usedGameIds.length} game${packet.usedGameIds.length === 1 ? '' : 's'} used`,
        packet.source,
      ]
        .filter(Boolean)
        .join(' · ')}
      actions={
        <div className="director-actions">
          <Button variant="secondary" icon="edit" onClick={onEdit}>
            Edit
          </Button>
          <ActionMenu label={`${packet.name} actions`} triggerLabel={`${packet.name} actions`}>
            {(close) => (
              <>
                {!isDefault && !packet.retired && (
                  <MenuItem
                    icon="check"
                    onSelect={() => {
                      close();
                      if (!state.tournament) {
                        onAnnounce(errorNotice('Create a tournament before selecting a default packet.'));
                        return;
                      }
                      controller.selectPacket(packet.id);
                      onAnnounce(`${packet.name} is now the default for newly generated rounds.`);
                    }}
                  >
                    Make default for new rounds
                  </MenuItem>
                )}
                <MenuItem
                  icon={packet.retired ? 'undo' : 'trash'}
                  tone={packet.retired ? 'default' : 'danger'}
                  onSelect={() => {
                    close();
                    void (async () => {
                      if (!packet.retired) {
                        const approved = await confirmAction({
                          title: `Retire ${packet.name}?`,
                          body: 'Its assignment and usage history will remain.',
                          consequence: 'Retired packets cannot be selected for future rounds until restored.',
                          confirmLabel: 'Retire packet',
                          tone: 'danger',
                        });
                        if (!approved) return;
                      }
                      const changed = controller.setPacketRetired(packet.id, !packet.retired);
                      if (changed) onAnnounce(`${packet.name} ${packet.retired ? 'restored' : 'retired'}.`);
                      else onAnnounce(errorNotice('The packet was not changed; review the Director error.'));
                    })();
                  }}
                >
                  {packet.retired ? 'Restore packet' : 'Retire packet…'}
                </MenuItem>
              </>
            )}
          </ActionMenu>
        </div>
      }
    >
      <Diagnostics
        label="Assignment history"
        standalone={false}
        hint="Round assignments, game use, replacement lineage, and raw unresolved references."
        items={[
          { term: 'Source', value: packet.source },
          { term: 'Round assignments', value: usingRounds.length || 'None' },
          { term: 'Game assignments', value: packet.assignedGameIds.length || 'None' },
          {
            term: 'Replacement',
            value: replacement
              ? `Replaces ${replacement.name}`
              : packet.replacementForPacketId
                ? 'Unknown packet reference'
                : 'None',
          },
        ]}
      >
        {packet.notes && (
          <p>
            <strong>Notes:</strong> {packet.notes}
          </p>
        )}
        {usingRounds.length > 0 && (
          <div className="director-actions">
            {usingRounds.map((round) => (
              <Button
                key={round.id}
                variant="quiet"
                icon="chevron"
                onClick={() =>
                  onNavigate?.('schedule', {
                    section: 'schedule',
                    entityType: 'round',
                    entityId: round.id,
                  })
                }
              >
                {round.name}
              </Button>
            ))}
          </div>
        )}
        {assignments.length > 0 && (
          <SummaryList ariaLabel={`${packet.name} game assignments`}>
            {assignments.map(({ assignmentId, scheduled, record }) => {
              const resolvedAssignmentId = scheduled?.id ?? assignmentId;
              const used =
                packet.usedGameIds.includes(assignmentId) ||
                packet.usedGameIds.includes(resolvedAssignmentId) ||
                Boolean(record?.acceptedAt);
              const round = scheduled
                ? state.rounds.find((entry) => entry.id === scheduled.roundId)
                : undefined;
              return (
                <SummaryItem
                  key={assignmentId}
                  title={
                    <strong>
                      {scheduled
                        ? `${teamName(state, scheduled.leftTeamId)} vs ${teamName(state, scheduled.rightTeamId)}`
                        : 'Unresolved assignment'}
                    </strong>
                  }
                  status={
                    <StateLabel state={used ? 'finished' : 'scheduled'} label={used ? 'Used' : 'Assigned'} />
                  }
                  summary={
                    scheduled
                      ? `${round?.name ?? 'Unknown round'}${scheduled.roomId ? ` · ${roomName(state, scheduled.roomId)}` : ''}`
                      : assignmentId
                  }
                />
              );
            })}
          </SummaryList>
        )}
      </Diagnostics>
    </SummaryItem>
  );
}

function PacketDialog({
  packet,
  controller,
  onAnnounce,
  onClose,
}: {
  packet?: DirectorState['packets'][number];
  controller: DirectorController;
  onAnnounce: (announcement: AnnounceInput) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(packet?.name ?? '');
  const [tiebreaker, setTiebreaker] = useState(packet?.tiebreaker ?? false);
  const [notes, setNotes] = useState(packet?.notes ?? '');
  const save = () => {
    const normalizedName = name.trim();
    if (!normalizedName) {
      onAnnounce(errorNotice('Enter a packet name first.'));
      return;
    }
    const saved = packet
      ? controller.updatePacket(packet.id, { name: normalizedName, tiebreaker, notes })
      : controller.addPacket(normalizedName, 'manual', { tiebreaker, notes });
    if (!saved) {
      onAnnounce(errorNotice(`Packet was not ${packet ? 'changed' : 'added'}; review the Director error.`));
      return;
    }
    onAnnounce(`${normalizedName} ${packet ? 'updated' : 'added to inventory'}.`);
    onClose();
  };
  return (
    <Dialog
      title={packet ? `Edit ${packet.name}` : 'Add packet'}
      description="Packet inventory is independent from round assignment."
      onClose={onClose}
      onSubmit={save}
      submitLabel={packet ? 'Save changes' : 'Add packet'}
    >
      <Field label="Packet name">
        <TextInput
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Round 1 · Set A"
        />
      </Field>
      <Checkbox
        checked={tiebreaker}
        label="Tiebreaker packet"
        hint="Marks this packet for use when a standalone tiebreaker is needed."
        onChange={setTiebreaker}
      />
      <Field label="Notes" optional hint="Handling or assignment notes for this packet.">
        <TextArea
          rows={3}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          placeholder="Keep sealed until the final tiebreaker"
        />
      </Field>
    </Dialog>
  );
}

function teamName(state: DirectorState, teamId: string | null): string {
  return teamId ? (state.teams.find((team) => team.id === teamId)?.displayName ?? 'Unknown team') : 'Bye';
}

function roomName(state: DirectorState, roomId: string): string {
  return state.rooms.find((room) => room.id === roomId)?.name ?? 'Unknown room';
}
