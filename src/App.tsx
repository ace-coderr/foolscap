import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Landing from './routes/Landing';
import City from './routes/City';
import Track from './routes/Track';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/city" element={<City />} />
        <Route path="/track" element={<Track />} />
        {/* The static site lived at these paths; old links still work. */}
        <Route path="/index.html" element={<Navigate to="/" replace />} />
        <Route path="/track.html" element={<Navigate to="/track" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
