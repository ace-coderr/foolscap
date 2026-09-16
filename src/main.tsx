import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/foolscap.css';
// Global now, not the landing route's. The shell renders the landing's nav on
// every page, so the stylesheet that draws it has to be there on every page.
import './styles/hero.css';
import './styles/bench.css';
import './styles/city.css';
import './styles/lens.css';
import './styles/vault.css';
import './styles/retention.css';

const root = document.getElementById('root');
if (!root) throw new Error('No #root element to mount into.');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
