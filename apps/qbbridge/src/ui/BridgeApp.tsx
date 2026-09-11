/**
 * Three areas and a title bar. That is the whole application.
 */

import { useState } from 'react';
import { Button, Notice, StatusBadge, Tab, TabList, TabPanel, Tabs } from '@qbsheet/ui';
import wordmark from '../assets/qbsheet-wordmark.svg';
import { useBridge } from '../model/useBridge';
import SetupView from './SetupView';
import RoomsView from './RoomsView';
import ResultsView from './ResultsView';
import HelpView from './HelpView';

const noticeTone = { good: 'success', warn: 'warning', bad: 'danger' } as const;

export default function BridgeApp() {
  const bridge = useBridge();
  const [tab, setTab] = useState('setup');
  const unsaved = bridge.state.results.filter((entry) => !entry.savedPath).length;

  return (
    <div id="app-root" className="shell">
      <header className="titlebar">
        {/*
         * The designed two-colour wordmark reads "QBSheet Bridge" on its own — seven black
         * glyphs and six green ones — so there is no text beside it to repeat. It is an `<img>`
         * rather than an inline `currentColor` SVG because the green is the mark rather than a
         * theme value, and `alt` carries the whole name so the heading has one accessible name.
         */}
        <h1>
          <img className="wordmark" src={wordmark} alt="QBSheet Bridge" />
        </h1>
        <span className="subtle">
          {bridge.tournament
            ? bridge.tournament.name
            : bridge.state.tournamentName
              ? `${bridge.state.tournamentName} — reload the .yft to publish`
              : 'No YellowFruit file loaded'}
        </span>
        {/*
         * Relay reachability as a word plus a tone, never a coloured dot alone. It rerenders on
         * every poll, so it is deliberately not a live region: a screen reader narrating "relay
         * connected" every five seconds is worse than silence.
         */}
        <span className="relay-state">
          {bridge.state.relay === null ? (
            <StatusBadge tone="neutral">Relay not connected</StatusBadge>
          ) : bridge.scorerReadiness?.status === 'blocked' ? (
            <StatusBadge tone="danger">Scorer cannot pair</StatusBadge>
          ) : bridge.scorerReadiness?.status !== 'ready' ? (
            <StatusBadge tone="warning">Scorer not verified</StatusBadge>
          ) : bridge.relayReachable === false ? (
            <StatusBadge tone="danger">Relay unavailable</StatusBadge>
          ) : (
            <StatusBadge tone="success">Relay connected</StatusBadge>
          )}
        </span>
      </header>

      <Tabs aria-label="QBSheet Bridge sections" selectedKey={tab} onSelectionChange={setTab}>
        <TabList aria-label="QBSheet Bridge sections">
          <Tab id="setup">Tournament</Tab>
          <Tab id="rooms">Rooms</Tab>
          <Tab id="results">{unsaved > 0 ? `Results (${unsaved} new)` : 'Results'}</Tab>
          <Tab id="help">Help</Tab>
        </TabList>

        <main>
          <div className="page-notices">
            {/*
             * One live region for the outcome of whatever the operator just did. A failure is
             * `assertive` because it means the thing they asked for did not happen; anything
             * else is `polite` and waits its turn.
             */}
            {bridge.notice ? (
              <Notice
                tone={noticeTone[bridge.notice.kind]}
                live={bridge.notice.kind === 'bad' ? 'assertive' : 'polite'}
                className="page-notice"
              >
                <span className="page-notice__message">{bridge.notice.message}</span>
                <Button
                  size="sm"
                  variant="quiet"
                  className="page-notice__dismiss"
                  aria-label="Dismiss notice"
                  onPress={bridge.dismissNotice}
                >
                  ×
                </Button>
              </Notice>
            ) : null}
            {bridge.persistenceSavePending ? (
              <Notice tone="warning">
                QBBridge cannot save the current tournament state on this machine. Recent room setup and
                other changes are only in memory and will be lost if the app restarts. Restore local storage
                access and retry before restarting.
                <Button
                  size="sm"
                  variant="quiet"
                  style={{ marginLeft: 'var(--qbs-space-2)' }}
                  onPress={bridge.retryStatePersistence}
                  isDisabled={bridge.busy}
                >
                  Retry saving local state
                </Button>
              </Notice>
            ) : null}
            {bridge.unsavedResultWarning ? (
              <Notice tone="warning">{bridge.unsavedResultWarning}</Notice>
            ) : null}
          </div>

          <TabPanel id="setup">
            <SetupView bridge={bridge} />
          </TabPanel>
          <TabPanel id="rooms">
            <RoomsView bridge={bridge} />
          </TabPanel>
          <TabPanel id="results">
            <ResultsView bridge={bridge} />
          </TabPanel>
          <TabPanel id="help">
            <HelpView />
          </TabPanel>
        </main>
      </Tabs>
    </div>
  );
}
