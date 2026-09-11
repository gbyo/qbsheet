import { createRoot } from 'react-dom/client';
import './app.css';
import BridgeApp from './ui/BridgeApp';

const root = document.getElementById('qbbridge-root');
if (root) createRoot(root).render(<BridgeApp />);
