import React, { useState } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ConsoleStatus } from '../shared/ConsoleStatus';
import { CentralProfileDrawer } from '../shared/CentralProfileDrawer';

const CentralHeader = ({ role, userProfile, onUpdateProfile, onLogout }) => {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const isOphth = role === 'ophthalmologist';
  const isSettingsRoute = location.pathname.endsWith('/settings');

  const [showProfileDrawer, setShowProfileDrawer] = useState(false);

  // Dark / Contrast Mode state matching phc-local-app
  const [isDark, setIsDark] = useState(() => {
    return document.documentElement.getAttribute('data-contrast') === 'dark' ||
      localStorage.getItem('netrasetu_contrast') === 'dark';
  });

  const toggleContrast = () => {
    const root = document.documentElement;
    const current = root.getAttribute('data-contrast');
    if (current === 'dark') {
      root.removeAttribute('data-contrast');
      localStorage.setItem('netrasetu_contrast', 'light');
      setIsDark(false);
    } else {
      root.setAttribute('data-contrast', 'dark');
      localStorage.setItem('netrasetu_contrast', 'dark');
      setIsDark(true);
    }
  };

  const OPTH_MESSAGES = [
    t('central.header.statusLive', 'CENTRAL SYSTEM ONLINE...'),
    'ML PIPELINE v4.2 CONNECTED',
    'GRAD-CAM MODULE READY',
    'LESION DETECTION ACTIVE',
    'CONFORMAL PREDICTION CALIBRATED',
    'AWAITING CASE SELECTION...',
  ];

  const ADMIN_MESSAGES = [
    'DISTRICT WORKER DASHBOARD LOADING...',
    'AGGREGATING PHC DATA...',
    'REFERRAL TRACKER ONLINE',
    'SYNC STATUS: ALL NODES CONNECTED',
    'ANALYTICS MODULE READY',
  ];

  // Derive display name from userProfile
  const displayName = userProfile?.fullName || userProfile?.email || 'Signed-in user';

  const navLinks = isOphth
    ? [
        { to: '/ophth/queue', label: t('central.header.nav.queue', 'CASES') },
      ]
    : [
        { to: '/admin/dashboard', label: t('central.header.nav.overview', 'OVERVIEW'), end: true },
        { to: '/admin/dashboard/detailed', label: t('central.header.nav.fullDashboard', 'DASHBOARD') },
        { to: '/admin/referrals', label: t('central.header.nav.referrals', 'REFERRALS') },
        { to: '/admin/phc-health', label: t('central.header.nav.phcHealth', 'PHC & SYSTEM HEALTH') },
        { to: '/admin/resources', label: t('central.header.nav.resources', 'RESOURCE PLANNING') },
      ];

  // If on full-page Settings, hide header so full-width settings header is active
  if (isSettingsRoute) {
    return (
      <CentralProfileDrawer
        isOpen={showProfileDrawer}
        onClose={() => setShowProfileDrawer(false)}
        role={role}
        userProfile={userProfile}
        onUpdateProfile={onUpdateProfile}
        onLogout={onLogout}
      />
    );
  }

  return (
    <>
      <header className="app-header">
        <div className="app-logo">
          NetraSetu
        </div>

        <div className="app-header__ticker">
          <ConsoleStatus messages={isOphth ? OPTH_MESSAGES : ADMIN_MESSAGES} />
        </div>

        <nav className="app-nav">
          {navLinks.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              end={link.end}
              className={({ isActive }) =>
                `app-nav__link ${isActive ? 'active' : ''}`
              }
            >
              {link.label}
            </NavLink>
          ))}
        </nav>

        <div className="app-header__actions" style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
          
          {/* Contrast / Dark Mode Toggle Button — Prominent, clearly visible */}
          <button
            type="button"
            onClick={toggleContrast}
            title={isDark ? "Switch to Light Mode" : "Switch to Dark Mode"}
            aria-label="Toggle Dark / Contrast Mode"
            style={{
              background: 'var(--c-cream-dark, #EDE0C8)',
              border: '1.5px solid var(--c-crimson)',
              color: 'var(--c-crimson)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px',
              padding: '6px 12px',
              fontFamily: 'var(--font-mono, monospace)',
              fontSize: '11px',
              fontWeight: 700,
              letterSpacing: '0.06em',
              boxShadow: '2px 2px 0px var(--c-crimson)',
              transition: 'all 0.15s ease'
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 2a10 10 0 0 1 0 20z" fill="currentColor" />
            </svg>
            <span>{isDark ? 'LIGHT' : 'DARK'}</span>
          </button>

          <span style={{ color: 'var(--c-crimson)', opacity: 0.3 }}>|</span>

          {/* Full-Page Settings trigger */}
          <button 
            type="button"
            className="app-header__help" 
            onClick={() => navigate(isOphth ? '/ophth/settings' : '/admin/settings')}
            title="Open Full Settings Screen"
            style={{ 
              background: 'none', border: 'none', color: 'var(--text-h)', cursor: 'pointer', fontFamily: 'var(--font-mono)', display: 'flex', alignItems: 'center', gap: '8px'
            }}
          >
            <span className="t-label" style={{ opacity: 0.5 }}>SETTINGS</span>
            <span style={{ fontSize: '12px', opacity: 0.8 }}>⚙</span>
          </button>

          <span style={{ color: 'var(--c-crimson)', opacity: 0.3 }}>|</span>

          {/* Role Badge: active Profile Drawer for both OPHTH and WORKER */}
          <div className="app-header__role-badge">
            {isOphth ? (
              <button
                className="app-header__role-btn t-label"
                onClick={() => setShowProfileDrawer(true)}
                title="Open Ophthalmologist Profile & Settings"
                style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
              >
                <span>◉ OPHTH:</span>
                <span style={{ fontWeight: 700, color: 'var(--c-crimson)' }}>
                  {displayName}
                </span>
              </button>
            ) : (
              <button
                className="app-header__role-btn t-label"
                onClick={() => setShowProfileDrawer(true)}
                title="Open District Worker Profile & Settings"
                style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
              >
                <span>⬡ WORKER:</span>
                <span style={{ fontWeight: 700, color: 'var(--c-crimson)' }}>
                  {displayName}
                </span>
              </button>
            )}
          </div>

          <button
            className="app-header__logout"
            onClick={onLogout}
            title="Switch Role / Logout"
            style={{ 
              background: 'none', border: 'none', color: 'var(--text-h)', cursor: 'pointer', fontFamily: 'var(--font-mono)', display: 'flex', alignItems: 'center', gap: '8px'
            }}
          >
            <span className="t-label">✕ {t('central.header.logout', 'EXIT')}</span>
          </button>
        </div>
      </header>

      {/* Unified Profile Drawer (for Ophthalmologist & District Worker) */}
      <CentralProfileDrawer
        isOpen={showProfileDrawer}
        onClose={() => setShowProfileDrawer(false)}
        role={role}
        userProfile={userProfile}
        onUpdateProfile={onUpdateProfile}
        onLogout={onLogout}
      />
    </>
  );
};

export { CentralHeader };
