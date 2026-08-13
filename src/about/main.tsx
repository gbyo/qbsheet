import { createRoot } from 'react-dom/client';
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import About from './About';
import './about.css';

const container = document.getElementById('about-root');
if (container) createRoot(container).render(<About />);
