import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { S, setS, loadSaved, toast } from './lib/store';
import { fresh } from './lib/seed';
import App from './App';

setS(loadSaved() || fresh());

createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>);

if (!S.log.length) setTimeout(() => toast('Try it: Margot is first on the Pottery evening waitlist. As Organizer, cancel a booking there; then come back as Member.'), 400);
