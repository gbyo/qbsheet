import { createRoot } from 'react-dom/client';
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/ibm-plex-sans/latin-700.css';
import '../../../src/director/director.css';
import DirectorApp from '../../../src/director/DirectorApp';
import { installCloseInterception } from './native';

// Guard the native close boundary (#731): the first close request flushes
// the persistence queue and only exits once the current revision is durable.
void installCloseInterception();

const root = document.getElementById('director-root');

if (root) {
  createRoot(root).render(<DirectorApp />);
}
