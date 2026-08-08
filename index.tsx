/**
 * Entry point for the browser room application.
 *
 * This bundle is completely separate from YellowFruit's Electron renderer. It runs in an ordinary
 * browser on a scorekeeper's machine, has no access to Electron APIs, and talks to YellowFruit only
 * over the local HTTP API.
 */
// Before RoomApp, which reaches modaq: modaq registers Fluent's icons at import time, and only the
// first registration counts. See fluentIcons.ts.
import './fluentIcons';
import { createRoot } from 'react-dom/client';
import RoomApp from './RoomApp';
import './room.css';

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(<RoomApp />);
}
