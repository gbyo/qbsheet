import { createRoot } from 'react-dom/client';
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/ibm-plex-sans/latin-700.css';
import './app.css';
import BridgeApp from './ui/BridgeApp';

const root = document.getElementById('qbbridge-root');
if (root) createRoot(root).render(<BridgeApp />);
