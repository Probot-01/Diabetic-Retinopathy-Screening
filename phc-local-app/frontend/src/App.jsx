import React, { useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { LoginScreen } from './components/screens/LoginScreen';
import { AppLayout } from './components/layout/AppLayout';
import { PatientRegistrationForm } from './components/screens/PatientRegistrationForm';
import { CaptureScreen } from './components/screens/CaptureScreen';
import { LocalQueueTable } from './components/screens/LocalQueueTable';
import { PairedDevicesPage } from './components/screens/PairedDevicesPage';
import { DemoDataBanner } from './components/shared/DemoDataBanner';

function App() {
  const [auth, setAuth] = useState(() => {
    const saved = localStorage.getItem('netra_phc_auth');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed && parsed.authenticated) {
          return parsed;
        }
      } catch (err) {
        console.warn('Failed to parse saved technician session', err);
      }
    }
    return null;
  });

  const handleLogin = (authPayload) => {
    localStorage.setItem('netra_phc_auth', JSON.stringify(authPayload));
    setAuth(authPayload);
  };

  const handleLogout = () => {
    localStorage.removeItem('netra_phc_auth');
    setAuth(null);
  };

  return (
    <BrowserRouter>
      <DemoDataBanner />
      <Routes>
        {/* Landing Page: Authentication Screen */}
        <Route
          path="/"
          element={
            !auth ? (
              <LoginScreen onLogin={handleLogin} />
            ) : (
              <Navigate to="/register" replace />
            )
          }
        />

        {/* Protected Technician Routes */}
        <Route
          element={
            auth ? (
              <AppLayout auth={auth} onLogout={handleLogout} />
            ) : (
              <Navigate to="/" replace />
            )
          }
        >
          <Route path="/register" element={<PatientRegistrationForm />} />
          <Route path="/capture" element={<CaptureScreen />} />
          <Route path="/queue" element={<LocalQueueTable />} />
          {/* Who can replicate patient records with this PC, and how to cut
              one off. auth carries the role the SERVER issued, so the screen
              can hide an admin-only action; the backend still enforces it. */}
          <Route path="/devices" element={<PairedDevicesPage auth={auth} />} />
        </Route>

        {/* Fallback to landing / dashboard */}
        <Route path="*" element={<Navigate to={auth ? "/register" : "/"} replace />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
