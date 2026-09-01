import { createRoot } from 'react-dom/client';
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/ibm-plex-sans/latin-700.css';
import '../../../src/director/director.css';
import DirectorApp from '../../../src/director/DirectorApp';

const root = document.getElementById('director-root');

if (root) {
  createRoot(root).render(<DirectorApp />);
}
