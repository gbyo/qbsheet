/**
 * Three areas and a title bar. That is the whole application.
 */

import { useState } from 'react';
import wordmark from '../assets/qbsheet-wordmark.svg';
import { useBridge } from '../model/useBridge';
import SetupView from './SetupView';
import RoomsView from './RoomsView';
import ResultsView from './ResultsView';
import HelpView from './HelpView';

type Tab = 'setup' | 'rooms' | 'results' | 'help';

export default function BridgeApp() {
  const bridge = useBridge();
  const [tab, setTab] = useState<Tab>('setup');
  const unsaved = bridge.state.results.filter((entry) => !entry.savedPath).length;

  return (
    <div className="shell">
      <header className="titlebar">
        {/*
         * The designed two-colour wordmark, as an image rather than inline `currentColor` SVG:
         * the green is the mark, not a theme value, and this window is light in both appearances.
         * `alt` carries the word so the heading's accessible name is still "QBSheet Bridge" —
         * a screen reader reads one name, not the mark and the name twice.
         */}
        <h1>
          <img className="wordmark" src={wordmark} alt="QBSheet" />
          <span>Bridge</span>
        </h1>
        <span className="subtle">
          {bridge.tournament
            ? bridge.tournament.name
            : bridge.state.tournamentName
              ? `${bridge.state.tournamentName} — reload the .yft to publish`
              : 'No YellowFruit file loaded'}
        </span>
        <span style={{ marginLeft: 'auto' }} className="status">
          {bridge.state.relay === null ? (
            <span className="muted">Relay not connected</span>
          ) : bridge.relayReachable === false ? (
            <span className="bad">Relay unavailable</span>
          ) : (
            <span className="good">Relay connected</span>
          )}
        </span>
      </header>

      <nav className="tabs">
        {(
          [
            ['setup', 'Tournament'],
            ['rooms', 'Rooms'],
            ['results', unsaved > 0 ? `Results (${unsaved} new)` : 'Results'],
            ['help', 'Help'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            aria-current={tab === key ? 'page' : undefined}
          >
            {label}
          </button>
        ))}
      </nav>

      <main>
        {bridge.notice ? (
          <div
            className={`notice ${bridge.notice.kind === 'bad' ? 'bad' : bridge.notice.kind === 'good' ? 'good' : ''}`}
            role="status"
          >
            {bridge.notice.message}
          </div>
        ) : null}
        {tab === 'setup' ? <SetupView bridge={bridge} /> : null}
        {tab === 'rooms' ? <RoomsView bridge={bridge} /> : null}
        {tab === 'results' ? <ResultsView bridge={bridge} /> : null}
        {tab === 'help' ? <HelpView /> : null}
      </main>
    </div>
  );
}
