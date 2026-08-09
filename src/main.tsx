/**
 * The entry point.
 *
 * Deliberately thin, and deliberately not wrapped in `StrictMode`. The scorer's state lives in refs
 * that are the authority for what has been scored (see `useGameEvents`), and double-invoking
 * effects in development to find missing cleanups is not worth a development-only behaviour
 * difference in the one part of this application where being wrong costs a room its game.
 */
import { createRoot } from 'react-dom/client';
import App from './app/App';
import { registerServiceWorker } from './pwa/registerServiceWorker';
import './app/app-shell.css';
import './app/readiness.css';
import './scorer/scorer.css';

const container = document.getElementById('root');
if (container) createRoot(container).render(<App />);

registerServiceWorker();
