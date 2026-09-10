import { createRoot } from 'react-dom/client';
import '../../../src/director/director.css';
import DirectorApp from '../../../src/director/DirectorApp';
import { installCloseInterception } from './native';

// Guard the native close boundary (#731): the first close request flushes
// the persistence queue and only exits once the current revision is durable.
void installCloseInterception();

/*
 * Director loads no webfont.
 *
 * It used to ship four weights of IBM Plex Sans, whose narrow, low-contrast
 * rendering in small sizes was a large part of why the application read as a
 * generic admin console rather than a desktop tool. The stylesheet now asks for
 * the platform's own UI face — San Francisco, Segoe UI, or the system default
 * on Linux — which is what every other application on the operator's desktop
 * uses, renders correctly at 13px, and costs nothing to load.
 */
const root = document.getElementById('director-root');

if (root) {
  createRoot(root).render(<DirectorApp />);
}
