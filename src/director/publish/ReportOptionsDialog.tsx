import { useState } from 'react';
import {
  defaultReportOptions,
  reportPageLabels,
  reportPageOrder,
  type ReportOptions,
  type ReportPageKey,
  type ReportPointsMetric,
} from '@qbsheet/tournament-formats';
import { Button, Checkbox, Dialog, DialogSection, Segmented } from '../components';

export function ReportOptionsDialog({
  options,
  onSave,
  onClose,
}: {
  options: ReportOptions;
  onSave: (options: ReportOptions) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<ReportOptions>(() => ({ ...options, pages: [...options.pages] }));
  const setPage = (page: ReportPageKey, checked: boolean) => {
    setDraft((current) => ({
      ...current,
      pages: checked
        ? reportPageOrder.filter((candidate) => current.pages.includes(candidate) || candidate === page)
        : current.pages.filter((candidate) => candidate !== page),
    }));
  };
  return (
    <Dialog
      title="Printable report options"
      description="Choose the pages and secondary columns for this Director. Competitive results and tournament data are unchanged."
      size="lg"
      onClose={onClose}
      onSubmit={() => {
        if (draft.pages.length > 0) onSave(draft);
      }}
      submitDisabled={draft.pages.length === 0}
      footer={
        <div className="director-dialog-footer">
          <Button
            variant="quiet"
            onClick={() => setDraft({ ...defaultReportOptions, pages: [...defaultReportOptions.pages] })}
          >
            Reset defaults
          </Button>
          <div className="director-actions">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" disabled={draft.pages.length === 0} onClick={() => onSave(draft)}>
              Save report options
            </Button>
          </div>
        </div>
      }
    >
      <DialogSection title="Pages">
        <p className="director-text-meta">
          At least one report page is required. The index page is always included.
        </p>
        {reportPageOrder.map((page) => (
          <Checkbox
            key={page}
            checked={draft.pages.includes(page)}
            label={reportPageLabels[page]}
            onChange={(checked) => setPage(page, checked)}
          />
        ))}
      </DialogSection>
      <DialogSection title="Scoring columns">
        <p className="director-text-meta">
          Rank, team/player identity, record, games played, and core scoring counts stay visible.
        </p>
        <Segmented<ReportPointsMetric>
          value={draft.pointsMetric}
          ariaLabel="Points display"
          options={[
            { value: 'ppg', label: 'PPG' },
            { value: 'pointsPerX', label: 'Points per regulation set' },
          ]}
          onChange={(pointsMetric) => setDraft((current) => ({ ...current, pointsMetric }))}
        />
        <Checkbox
          checked={draft.showPointsForAgainstMargin}
          label="Points for, points against, and margin"
          onChange={(showPointsForAgainstMargin) =>
            setDraft((current) => ({ ...current, showPointsForAgainstMargin }))
          }
        />
        <Checkbox
          checked={draft.showPapg}
          label="Points against per game"
          onChange={(showPapg) => setDraft((current) => ({ ...current, showPapg }))}
        />
        <Checkbox
          checked={draft.showClassifications}
          label="Reporting classifications when used"
          onChange={(showClassifications) => setDraft((current) => ({ ...current, showClassifications }))
        />
      </DialogSection>
      <DialogSection title="Context columns">
        <Checkbox
          checked={draft.showPacket}
          label="Packet when known"
          onChange={(showPacket) => setDraft((current) => ({ ...current, showPacket }))}
        />
        <Checkbox
          checked={draft.showStage}
          label="Stage when multiple stages are present"
          onChange={(showStage) => setDraft((current) => ({ ...current, showStage }))}
        />
      </DialogSection>
    </Dialog>
  );
}
