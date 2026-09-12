import { createRoot } from 'react-dom/client';
import './app.css';
import ShuttleApp from './ui/ShuttleApp';

const root = document.getElementById('yfshuttle-root');
if (root) createRoot(root).render(<ShuttleApp />);
