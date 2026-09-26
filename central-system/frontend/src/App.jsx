import React, { useState, useEffect, useCallback, Component } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { EyeJourneyLogin } from './components/screens/EyeJourneyLogin';
import { CentralLayout } from './components/layout/CentralLayout';
import { ReviewQueuePage } from './components/screens/ReviewQueuePage';
import { CaseDetailPage } from './components/screens/CaseDetailPage';
import { DashboardPage } from './components/screens/DashboardPage';
import { AdminScrollDashboard } from './components/screens/AdminScrollDashboard';
import { ReferralTrackerPage } from './components/screens/ReferralTrackerPage';
import { PhcHealthPage } from './components/screens/PhcHealthPage';
import { ResourceRecommendationsPanel } from './components/screens/ResourceRecommendationsPanel';
import { CentralProfilePage } from './components/screens/CentralProfilePage';
import { CentralSettingsPage } from './components/settings/CentralSettingsPage';
import { DemoDataBanner } from './components/shared/DemoDataBanner';
import { centralApi, UNAUTHENTICATED_EVENT } from './api/centralApiClient';
import { USE_MOCK_DATA } from './config';

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, errorInfo) {
    console.error('App ErrorBoundary caught error:', error, errorInfo);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '40px', maxWidth: '600px', margin: '60px auto', background: '#FFF8F0', border: '2px solid #A82222', boxShadow: '4px 4px 0px #A82222' }}>
          <h2 style={{ color: '#A82222', margin: '0 0 16px 0', fontFamily: 'monospace' }}>APPLICATION ERROR</h2>
          <p style={{ color: '#2C1810', fontFamily: 'monospace', fontSize: '13px' }}>{this.state.error?.message || 'An unexpected error occurred.'}</p>
          <button
            onClick={() => {
              localStorage.removeItem('netra_user_role');
              window.location.href = '/';
            }}
            style={{ marginTop: '20px', padding: '10px 20px', background: '#A82222', color: '#FFF', border: 'none', cursor: 'pointer', fontFamily: 'monospace', fontWeight: 700 }}
          >
            RETURN TO LOGIN
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// Server role -> the app's route namespace.
const appRole = (serverRole) => (serverRole === 'district_admin' ? 'admin' : serverRole === 'ophthalmologist' ? 'ophthalmologist' : null);

/**
 * Live mode: the profile shown in the header comes from the authenticated
 * session (design doc §5.1/§5.2 "reviewer identity comes from the
 * authenticated session"). Only what the server knows is filled in.
 */
const profileFromUser = (user) => ({
  username: user.email,
  fullName: user.name,
  email: user.email,
  phone: '',
  location: '',
  designation: user.role === 'district_admin' ? 'District Admin' : 'Ophthalmologist',
  officerId: '',
  district: '',
  role: appRole(user.role),
});

// Mock mode only: the demo profile the design was built around.
const demoProfile = (role, username) => {
  const isDoc = role === 'ophthalmologist';
  const cleanUser = username && username.trim() ? username.trim() : 'demo';
  return {
    username: cleanUser,
    fullName: isDoc ? 'Dr. Demo Ophthalmologist' : 'Demo District Admin',
    phone: '',
    location: isDoc ? 'District Civil Hospital' : 'District Health Office',
    email: '',
    designation: isDoc ? 'Ophthalmologist' : 'District Health Worker (DHW)',
    officerId: '',
    district: '',
    role,
  };
};

const RoleRouter = () => {
  // Live mode trusts nothing stored in the browser: the role comes from the
  // server (/auth/me), and until that answers, protected routes wait.
  const [role, setRole] = useState(() =>
    USE_MOCK_DATA ? (localStorage.getItem('netra_user_role') || null) : null);
  const [authChecked, setAuthChecked] = useState(USE_MOCK_DATA);
  const [userProfile, setUserProfile] = useState(() => {
    if (!USE_MOCK_DATA) return null;
    const saved = localStorage.getItem('netra_user_profile');
    if (saved) {
      try { return JSON.parse(saved); } catch (e) {}
    }
    return demoProfile(localStorage.getItem('netra_user_role') || 'ophthalmologist');
  });
  const navigate = useNavigate();

  // Initialize theme, text size (--fs), and high contrast on startup
  useEffect(() => {
    const savedContrast = localStorage.getItem('netrasetu_contrast');
    if (savedContrast === 'dark') {
      document.documentElement.setAttribute('data-contrast', 'dark');
    }
    try {
      const savedSettings = localStorage.getItem('netrasetu_settings');
      if (savedSettings) {
        const parsed = JSON.parse(savedSettings);
        if (parsed.textSize) {
          const sizeMap = { Small: '12px', Normal: '14px', Large: '16px' };
          document.documentElement.style.setProperty('--fs', sizeMap[parsed.textSize] || '14px');
        }
        if (parsed.highContrast) {
          document.documentElement.classList.add('high-contrast-mode');
        }
      }
    } catch (e) {}
  }, []);

  // Live: recover the session after a reload (the cookie is httpOnly, so only
  // the server can say who this is).
  useEffect(() => {
    if (USE_MOCK_DATA) return;
    let cancelled = false;
    centralApi.me()
      .then((s) => {
        if (cancelled) return;
        setRole(appRole(s.user.role));
        setUserProfile(profileFromUser(s.user));
      })
      .catch(() => { /* not logged in: stay on the login page */ })
      .finally(() => { if (!cancelled) setAuthChecked(true); });
    return () => { cancelled = true; };
  }, []);

  const clearSession = useCallback(() => {
    localStorage.removeItem('netra_user_role');
    setRole(null);
    setUserProfile(null);
  }, []);

  // Global 401 handler: any API call that finds the session gone lands here.
  useEffect(() => {
    if (USE_MOCK_DATA) return undefined;
    const onUnauth = () => { clearSession(); navigate('/', { replace: true }); };
    window.addEventListener(UNAUTHENTICATED_EVENT, onUnauth);
    return () => window.removeEventListener(UNAUTHENTICATED_EVENT, onUnauth);
  }, [clearSession, navigate]);

  // Live: called with the server's user after a successful POST /auth/login.
  // Mock: called with the demo role and username.
  const handleLogin = (selectedRole, username, serverUser) => {
    const profile = serverUser ? profileFromUser(serverUser) : demoProfile(selectedRole, username);
    if (USE_MOCK_DATA) {
      localStorage.setItem('netra_user_role', selectedRole);
      localStorage.setItem('netra_user_profile', JSON.stringify(profile));
    }
    setRole(selectedRole);
    setUserProfile(profile);
    navigate(selectedRole === 'ophthalmologist' ? '/ophth/queue' : '/admin/dashboard');
  };

  const handleLogout = async () => {
    if (!USE_MOCK_DATA) await centralApi.logout().catch(() => {});
    clearSession();
    navigate('/');
  };

  const handleUpdateProfile = (newProfile) => {
    const merged = { ...userProfile, ...newProfile };
    if (USE_MOCK_DATA) localStorage.setItem('netra_user_profile', JSON.stringify(merged));
    setUserProfile(merged);
  };

  // Route guard: the right role gets the layout, anyone else goes to login.
  // The server enforces the same rule on every endpoint; this only keeps the
  // UI from showing screens whose every request would be refused.
  const guard = (needed) => {
    if (!authChecked) return null;   // waiting for /auth/me
    if (role === needed) {
      return <CentralLayout role={role} userProfile={userProfile} onUpdateProfile={handleUpdateProfile} onLogout={handleLogout} />;
    }
    if (role) return <Navigate to={role === 'ophthalmologist' ? '/ophth/queue' : '/admin/dashboard'} replace />;
    return <Navigate to="/" replace />;
  };

  return (
    <Routes>
      <Route path="/" element={
        authChecked && role
          ? <Navigate to={role === 'ophthalmologist' ? '/ophth/queue' : '/admin/dashboard'} replace />
          : <EyeJourneyLogin onLogin={handleLogin} />
      } />

      {/* Ophthalmologist Routes */}
      <Route path="/ophth" element={guard('ophthalmologist')}>
        <Route index element={<Navigate to="queue" replace />} />
        <Route path="queue" element={<ReviewQueuePage />} />
        <Route path="case/:caseId" element={<CaseDetailPage />} />
        <Route path="profile" element={<CentralProfilePage />} />
        <Route path="settings" element={<CentralSettingsPage />} />
      </Route>

      {/* Admin Routes */}
      <Route path="/admin" element={guard('admin')}>
        <Route index element={<Navigate to="dashboard" replace />} />
        <Route path="dashboard" element={<AdminScrollDashboard />} />
        <Route path="dashboard/detailed" element={<DashboardPage />} />
        <Route path="referrals" element={<ReferralTrackerPage />} />
        <Route path="phc-health" element={<PhcHealthPage />} />
        <Route path="resources" element={<ResourceRecommendationsPanel />} />
        <Route path="profile" element={<CentralProfilePage />} />
        <Route path="settings" element={<CentralSettingsPage />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
};

function App() {
  return (
    <ErrorBoundary>
      <DemoDataBanner />
      <BrowserRouter>
        <RoleRouter />
      </BrowserRouter>
    </ErrorBoundary>
  );
}

export default App;
