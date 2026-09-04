import { createRoot } from 'react-dom/client';
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/ibm-plex-sans/latin-700.css';
import '../app/app-shell.css';
import './creator.css';
import GamePackageCreator from './GamePackageCreator';

// A separate document: no scorer bootstrap, pairing, database, or service-worker registration.
const root = document.getElementById('root');
if (root) createRoot(root).render(<GamePackageCreator />);
