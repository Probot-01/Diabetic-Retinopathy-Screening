import React, { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { localApi } from '../../api/localApiClient';
import { PHC_NAME } from '../../config';
import { ConsoleStatus } from '../shared/ConsoleStatus';
import { LanguageSelector } from '../shared/LanguageSelector';

export const Header = ({ auth, onLogout }) => {
  const { t } = useTranslation();
  const [syncStatus, setSyncStatus] = useState({ online: false, pendingCount: 0 });
  const [localError, setLocalError] = useState(null);

  useEffect(() => {
    // Poll sync status
    const fetchSync = async () => {
      try {
        const status = await localApi.getSyncStatus();
        setSyncStatus(status);
        setLocalError(null);
      } catch (err) {
        // Not "central is offline": THIS PC's backend did not answer, so the
        // pending count is unknown too. Say that, not a stale number.
        console.error('Failed to get sync status', err);
        setLocalError(err);
      }
    };
    
    fetchSync();
    const interval = setInterval(fetchSync, 10000);
    return () => clearInterval(interval);
  }, []);

  const toggleContrast = () => {
    const root = document.documentElement;
    const current = root.getAttribute('data-contrast');
    if (current === 'dark') {
      root.removeAttribute('data-contrast');
    } else {
      root.setAttribute('data-contrast', 'dark');
    }
  };

  return (
    <header className="app-header">
      {/* Brand */}
      <div className="app-logo">
        {t('header.title').replace('Setu', '')}<span className="star">Setu</span>
      </div>
      
      {/* Terminal Output */}
      <div style={{ flex: 1 }}>
        <ConsoleStatus />
      </div>
      
      {/* Navigation */}
      <nav className="app-nav">
        <NavLink to="/register" className={({isActive}) => isActive ? "app-nav__link active" : "app-nav__link"}>
          {t('header.nav.register')}
        </NavLink>
        <NavLink to="/queue" className={({isActive}) => isActive ? "app-nav__link active" : "app-nav__link"}>
          {t('header.nav.queue')}
        </NavLink>
      </nav>
      
      <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
        <LanguageSelector />
        
        {/* Contrast Toggle */}
        <button onClick={toggleContrast} title="Toggle Contrast Mode">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 2a10 10 0 0 1 0 20z" fill="currentColor" />
          </svg>
        </button>
      </div>

      {/* Operator Info & Logout */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
        <div className="app-header__operator-badge" title={`Active Operator: ${auth?.name || 'Krrish Gadekar'}`}>
          <div className="app-header__operator-dot" />
          <div className="app-header__operator-info">
            <span className="app-header__operator-role">{auth?.roleTitle || 'PHC TECHNICIAN'}</span>
            <span className="app-header__operator-name">{auth?.name || auth?.username || 'Krrish Gadekar'}</span>
          </div>
        </div>

        {onLogout && (
          <button
            type="button"
            className="app-header__logout-btn"
            onClick={onLogout}
            title={t('header.logout', 'Log out of technician session')}
          >
            <span>LOGOUT</span>
            <span style={{ fontSize: '12px' }}>⏻</span>
          </button>
        )}
      </div>

      {/* Sync Status & PHC Info */}
      <div>
        <div className="u-flex-col">
          <span className="t-mono" style={{ fontSize: '10px' }}>{PHC_NAME}</span>
          {localError ? (
            <div className="sync-badge u-mt-1" title={localError.message}>
              <div className="sync-dot sync-dot--offline"></div>
              <span>PHC BACKEND UNREACHABLE</span>
            </div>
          ) : (
            <div className="sync-badge u-mt-1">
              <div className={`sync-dot ${syncStatus.online ? 'sync-dot--online' : 'sync-dot--offline'}`}></div>
              <span>{syncStatus.online ? t('header.status.online') : t('header.status.offline')}</span>
              <span style={{ opacity: 0.5, marginLeft: '4px' }}>
                ● {syncStatus.pendingCount} {t('header.status.pending')}
              </span>
              {syncStatus.awaitingFormsCount > 0 && (
                <span style={{ marginLeft: '6px', color: 'var(--c-warning)' }}
                  title="Passed the quality check but will not upload until both questionnaires are recorded.">
                  ● {syncStatus.awaitingFormsCount} AWAITING QUESTIONNAIRE
                </span>
              )}
              {syncStatus.lastError && (
                <span style={{ marginLeft: '6px', color: 'var(--c-crimson)', fontWeight: 700 }}
                  title={syncStatus.lastError.message} data-testid="sync-last-error">
                  ⚠ {syncStatus.lastError.kind === 'network' ? 'UPLOAD INTERRUPTED' : 'CENTRAL REFUSED AN UPLOAD'}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </header>
  );
};

