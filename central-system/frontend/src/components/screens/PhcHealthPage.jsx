import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { centralApi } from '../../api/centralApiClient';
import { LoadError } from '../shared/LoadError';

// 3-State Sort Header Component (Matching Reference Image 2)
const SortHeader = React.memo(({ label, field, sortKey, sortDir, onSort, alignRight = false }) => {
  const isSorted = sortKey === field && sortDir !== 'none';
  return (
    <th
      className={`th-sortable ${alignRight ? 'u-text-right' : ''}`}
      onClick={() => onSort(field)}
      title={`Sort by ${label} (Current: ${isSorted ? sortDir.toUpperCase() : 'DEFAULT'})`}
    >
      <span className="th-sort-inner" style={alignRight ? { justifyContent: 'flex-end' } : {}}>
        <span>{label}</span>
        <span className={`th-sort-icon ${isSorted ? 'th-sort-icon--active' : ''}`}>
          {sortKey === field && sortDir === 'asc'
            ? '↑'
            : sortKey === field && sortDir === 'desc'
            ? '↓'
            : '⇅'}
        </span>
      </span>
    </th>
  );
});
SortHeader.displayName = 'SortHeader';

const HOUR_MS = 3_600_000;

// One row of GET /admin/phcs. Only what the API says: nothing here is derived
// into a score or a "total screened" the server did not send.
const PhcRow = React.memo(({ phc }) => {
  const { t } = useTranslation();
  const isActive = phc.status === 'active';
  const ageH = phc.lastSyncAt ? (Date.now() - new Date(phc.lastSyncAt).getTime()) / HOUR_MS : null;

  return (
    <tr style={!isActive ? { opacity: 0.9, background: 'rgba(168, 34, 34, 0.05)' } : {}}>
      <td>
        <span className={`badge ${isActive ? 'badge--pass' : 'badge--fail'}`} data-testid="phc-status">
          {isActive ? t('central.phcHealth.table.active', 'ACTIVE') : t('central.phcHealth.table.silent', 'SILENT')}
        </span>
      </td>
      <td className="t-mono" style={{ fontWeight: 700 }}>{phc.name}</td>
      <td className="t-mono" style={{ color: 'var(--c-text-muted)', fontWeight: 500 }}>{phc.phcCode ?? '—'}</td>
      <td className="t-mono" style={{ color: 'var(--c-text-muted)' }}>{phc.district ?? '—'}</td>
      <td className="t-mono u-text-right" style={{ fontSize: 'var(--fs-tiny)', color: 'var(--c-text-muted)' }} data-testid="phc-last-sync">
        {phc.lastSyncAt
          ? new Date(phc.lastSyncAt).toLocaleString('en-IN', {
              timeZone: 'Asia/Kolkata',
              day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
            })
          : t('central.phcHealth.table.never', 'NEVER')}
        {ageH !== null && ageH >= 1 && (
          <span style={{ color: 'var(--c-warning)', marginLeft: 'var(--sp-2)', fontWeight: 700 }}>
            ({Math.round(ageH)}{t('central.phcHealth.table.hAgo', 'h ago')})
          </span>
        )}
      </td>
      <td className="t-mono u-text-right" style={{ fontWeight: 700 }}>{phc.casesLast24h}</td>
      <td className="u-text-right">
        <span className={`badge ${phc.pendingOrFailedCount === 0 ? 'badge--pass' : phc.pendingOrFailedCount > 5 ? 'badge--fail' : 'badge--warning'}`}>
          {phc.pendingOrFailedCount}
        </span>
      </td>
    </tr>
  );
});
PhcRow.displayName = 'PhcRow';

export const PhcHealthPage = () => {
  const { t } = useTranslation();
  const [phcList, setPhcList] = useState([]);
  const [systemHealth, setSystemHealth] = useState(null);
  const [loading, setLoading] = useState(true);
  // Two independent sources, so two independent failures: System Health can
  // be live while the PHC list has no endpoint (centralApiClient), and one
  // must not blank the other.
  const [phcError, setPhcError] = useState(null);
  const [healthError, setHealthError] = useState(null);
  const [statusFilter, setStatusFilter] = useState('all');

  // 3-State Column Sorting
  const [sortConfig, setSortConfig] = useState({ key: null, direction: 'none' });

  useEffect(() => {
    let active = true;
    Promise.allSettled([
      centralApi.getPhcSyncStatuses(),
      centralApi.getSystemHealth(),
    ]).then(([phcs, health]) => {
      if (!active) return;
      if (phcs.status === 'fulfilled') setPhcList(phcs.value); else setPhcError(phcs.reason);
      if (health.status === 'fulfilled') setSystemHealth(health.value); else setHealthError(health.reason);
      setLoading(false);
    });
    return () => { active = false; };
  }, []);

  const handleSort = useCallback((field) => {
    setSortConfig(prev => {
      if (prev.key !== field) {
        return { key: field, direction: 'asc' };
      }
      if (prev.direction === 'asc') {
        return { key: field, direction: 'desc' };
      }
      if (prev.direction === 'desc') {
        return { key: null, direction: 'none' };
      }
      return { key: field, direction: 'asc' };
    });
  }, []);

  const activeCount = useMemo(() => phcList.filter(p => p.status === 'active').length, [phcList]);
  const silentCount = useMemo(() => phcList.filter(p => p.status === 'silent').length, [phcList]);
  const totalPending = useMemo(() => phcList.reduce((sum, p) => sum + p.pendingOrFailedCount, 0), [phcList]);
  const totalCases24h = useMemo(() => phcList.reduce((sum, p) => sum + p.casesLast24h, 0), [phcList]);

  const processedPhcs = useMemo(() => {
    let list = phcList;
    if (statusFilter === 'active') list = list.filter(p => p.status === 'active');
    if (statusFilter === 'silent') list = list.filter(p => p.status === 'silent');
    if (statusFilter === 'pending') list = list.filter(p => p.pendingOrFailedCount > 0);

    if (sortConfig.direction === 'none' || !sortConfig.key) {
      return list;
    }

    return [...list].sort((a, b) => {
      let valA = a[sortConfig.key];
      let valB = b[sortConfig.key];

      if (sortConfig.key === 'lastSyncAt') {
        valA = valA ? new Date(valA).getTime() : 0;
        valB = valB ? new Date(valB).getTime() : 0;
      } else if (typeof valA === 'string') {
        valA = valA.toLowerCase();
      }

      if (valA < valB) return sortConfig.direction === 'asc' ? -1 : 1;
      if (valA > valB) return sortConfig.direction === 'asc' ? 1 : -1;
      return 0;
    });
  }, [phcList, statusFilter, sortConfig]);

  if (loading) {
    return (
      <div className="section">
        <div className="skeleton" style={{ height: '40px', width: '300px', marginBottom: 'var(--sp-6)' }} />
        {[...Array(4)].map((_, i) => (
          <div key={i} className="skeleton" style={{ height: '100px', marginBottom: 'var(--sp-2)' }} />
        ))}
      </div>
    );
  }

  // The four checks of design §5.3 / §10.7, each true when tripped.
  const trippedChecks = systemHealth ? [
    systemHealth.silentPhcs?.length > 0,
    systemHealth.stuckJobs?.length > 0,
    systemHealth.matlabSessionStatus !== 'healthy',
    systemHealth.unreviewedCases?.length > 0,
  ].filter(Boolean).length : 0;
  const hasCriticalAlerts = trippedChecks > 0 || (systemHealth?.alerts?.length ?? 0) > 0;

  return (
    <div className="section">
      {healthError && <LoadError error={healthError} what="system health" />}

      {/* Consolidated System Health Banner (§5.3 / §10.7) */}
      {hasCriticalAlerts && (
        <div
          style={{
            border: '2px solid var(--c-crimson)',
            background: 'rgba(168, 34, 34, 0.08)',
            padding: '16px 20px',
            marginBottom: 'var(--sp-6)',
            boxShadow: '4px 4px 0px var(--c-crimson)',
          }}
        >
          <div className="u-flex u-items-center u-justify-between u-mb-2">
            <div className="u-flex u-items-center" style={{ gap: '8px' }}>
              <span className="badge badge--fail" style={{ fontSize: '11px', padding: '3px 8px' }}>
                CRITICAL SYSTEM HEALTH EXCEPTION
              </span>
              <span className="t-mono" style={{ fontSize: '11px', fontWeight: 700, color: 'var(--c-crimson)' }}>
                {trippedChecks} OF 4 CHECKS TRIPPED · {systemHealth.alerts?.length ?? 0} OPEN ALERT{(systemHealth.alerts?.length ?? 0) === 1 ? '' : 'S'}
              </span>
            </div>
            <span className="t-mono" style={{ fontSize: '10px', color: 'var(--c-text-muted)' }}>
              Consolidated Watchdog Monitor (§10.7)
            </span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginTop: '10px' }}>
            {systemHealth.alerts?.map((alert, idx) => (
              <div
                key={idx}
                style={{
                  background: 'rgba(255,255,255,0.7)',
                  border: '1px solid var(--c-crimson)',
                  padding: '10px 12px',
                  fontFamily: 'var(--f-mono)',
                  fontSize: '11px',
                }}
              >
                <div style={{ fontWeight: 700, color: 'var(--c-crimson)', marginBottom: '4px' }}>
                  ⚠ {String(alert.kind || 'alert').replace(/_/g, ' ').toUpperCase()}{alert.subject ? ` — ${alert.subject}` : ''}
                  {alert.occurrences > 1 ? ` (×${alert.occurrences})` : ''}
                </div>
                <div style={{ color: 'var(--c-text)', opacity: 0.9 }}>
                  {alert.message}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 4-Check Status Bar (Silent PHCs, Stuck Jobs, MATLAB, Clinical SLA) */}
      {systemHealth && (
        <div className="bento u-mb-6">
          <div className="bento--span-3">
            <div className="stat hash-fill">
              <div className="stat__label">SILENT PHCs (&gt;{systemHealth.thresholds?.silentPhcHours ?? 24}H)</div>
              <div className="stat__value" style={{ color: systemHealth.silentPhcs.length > 0 ? '#A82222' : 'var(--c-success)' }}>
                {systemHealth.silentPhcs.length}
              </div>
              <div className="stat__delta" style={{ color: systemHealth.silentPhcs.length > 0 ? '#A82222' : 'var(--c-success)' }}>
                {systemHealth.silentPhcs.length > 0 ? 'Physical inspection needed' : 'All clinics in contact'}
              </div>
            </div>
          </div>

          <div className="bento--span-3">
            <div className="stat hash-fill">
              <div className="stat__label">STUCK PIPELINE JOBS</div>
              <div className="stat__value" style={{ color: systemHealth.stuckJobs.length > 0 ? '#F97316' : 'var(--c-success)' }}>
                {systemHealth.stuckJobs.length}
              </div>
              <div className="stat__delta" style={{ color: 'var(--c-text-muted)' }}>
                {systemHealth.stuckJobs.length > 0 ? 'Auto-recovery in progress' : 'Pipeline clear (&lt;15m)'}
              </div>
            </div>
          </div>

          <div className="bento--span-3">
            <div className="stat hash-fill">
              <div className="stat__label">MATLAB SESSION STATUS</div>
              <div className="stat__value" style={{ color: systemHealth.matlabSessionStatus === 'healthy' ? '#14B8A6' : '#A82222' }}>
                {systemHealth.matlabSessionStatus.toUpperCase()}
              </div>
              <div className="stat__delta" style={{ color: 'var(--c-success)' }}>
                {systemHealth.matlabSession?.pid != null ? `PID: ${systemHealth.matlabSession.pid} • ` : ''}
                {systemHealth.matlabSession?.restartsInWindow ?? '—'} restarts in window
              </div>
            </div>
          </div>

          <div className="bento--span-3">
            <div className="stat hash-fill">
              <div className="stat__label">SLA AGING (&gt;48H UNREVIEWED)</div>
              <div className="stat__value" style={{ color: systemHealth.unreviewedCases.length > 0 ? '#A82222' : 'var(--c-success)' }}>
                {systemHealth.unreviewedCases.length}
              </div>
              <div className="stat__delta" style={{ color: systemHealth.unreviewedCases.length > 0 ? '#A82222' : 'var(--c-success)' }}>
                {systemHealth.unreviewedCases.length > 0
                  ? `${systemHealth.unreviewedCases.length} case${systemHealth.unreviewedCases.length === 1 ? '' : 's'} past SLA`
                  : 'Within 48h SLA'}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Page Header */}
      <div className="u-flex u-items-center u-justify-between u-mb-6">
        <div>
          <p className="section__subtitle">{t('central.phcHealth.subtitle', 'DISTRICT WORKER')}</p>
          <h1 className="section__title" style={{ marginBottom: 0 }}>{t('central.phcHealth.title', 'PHC HEALTH')}</h1>
        </div>
        {/* Interactive filter badges */}
        {!phcError && <div className="u-flex u-gap-3 u-items-center">
          {sortConfig.direction !== 'none' && (
            <button
              className="btn btn--secondary"
              style={{ padding: 'var(--sp-1) var(--sp-3)', fontSize: 'var(--fs-tiny)' }}
              onClick={() => setSortConfig({ key: null, direction: 'none' })}
              title="Reset sorting to default"
            >
              {t('central.phcHealth.filters.resetSort', 'RESET SORT (✕)')}
            </button>
          )}
          <button
            onClick={() => setStatusFilter('all')}
            className={`btn ${statusFilter === 'all' ? 'btn--primary' : 'btn--secondary'}`}
            style={{
              padding: 'var(--sp-1) var(--sp-3)',
              fontSize: 'var(--fs-tiny)',
              boxShadow: statusFilter === 'all' ? '3px 3px 0px #000' : '2px 2px 0px var(--c-crimson)',
            }}
          >
            {t('central.phcHealth.filters.all', 'ALL')} ({phcList.length})
          </button>
          <button
            onClick={() => setStatusFilter(statusFilter === 'active' ? 'all' : 'active')}
            className={`badge badge--pass ${statusFilter === 'active' ? 'badge--active' : ''}`}
            style={{
              cursor: 'pointer',
              border: statusFilter === 'active' ? '2px solid #000' : '1px solid currentColor',
              boxShadow: statusFilter === 'active' ? '3px 3px 0px #000' : 'none',
              transform: statusFilter === 'active' ? 'translate(-1px, -1px)' : 'none',
            }}
            title="Filter by active PHCs (sent a case within the window)"
          >
            {activeCount} {t('central.phcHealth.filters.active', 'ACTIVE')}
          </button>
          <button
            onClick={() => setStatusFilter(statusFilter === 'silent' ? 'all' : 'silent')}
            className={`badge badge--fail ${statusFilter === 'silent' ? 'badge--active' : ''}`}
            style={{
              cursor: 'pointer',
              background: statusFilter === 'silent' ? '#A82222' : 'rgba(168, 34, 34, 0.1)',
              color: statusFilter === 'silent' ? '#FFF' : '#A82222',
              fontWeight: 700,
              border: statusFilter === 'silent' ? '2px solid #000' : '1px solid #A82222',
              boxShadow: statusFilter === 'silent' ? '3px 3px 0px #000' : 'none',
              transform: statusFilter === 'silent' ? 'translate(-1px, -1px)' : 'none',
            }}
            title="Filter by silent PHCs (no contact within the configured window)"
          >
            ⚠ {silentCount} SILENT
          </button>
          <button
            onClick={() => setStatusFilter(statusFilter === 'pending' ? 'all' : 'pending')}
            className={`badge badge--neutral ${statusFilter === 'pending' ? 'badge--active' : ''}`}
            style={{
              cursor: 'pointer',
              border: statusFilter === 'pending' ? '2px solid #000' : '1px solid currentColor',
              boxShadow: statusFilter === 'pending' ? '3px 3px 0px #000' : 'none',
              transform: statusFilter === 'pending' ? 'translate(-1px, -1px)' : 'none',
            }}
            title="Filter by PHCs with Pending Sync"
          >
            {totalPending} {t('central.phcHealth.filters.pending', 'PENDING')}
          </button>
        </div>}
      </div>

      {phcError ? <LoadError error={phcError} what="the PHC list" /> : (<>
      {/* Summary Stats - 3 Key Metric Cards with brutalist shadow and clean borders */}
      <div className="bento u-mb-6">
        <div className="bento--span-4">
          <div className="stat" style={{ border: '1px solid rgba(0,0,0,0.08)', boxShadow: '4px 4px 0px var(--c-crimson)' }}>
            <div className="stat__label">{t('central.phcHealth.stats.totalPhcs', 'TOTAL PHCs')}</div>
            <div className="stat__value">{phcList.length}</div>
          </div>
        </div>
        <div className="bento--span-4">
          <div className="stat" style={{ border: '1px solid rgba(0,0,0,0.08)', boxShadow: '4px 4px 0px var(--c-crimson)' }}>
            <div className="stat__label">{t('central.phcHealth.stats.cases24h', 'CASES (LAST 24H)')}</div>
            <div className="stat__value">{totalCases24h.toLocaleString()}</div>
          </div>
        </div>
        <div className="bento--span-4">
          <div className="stat" style={{ border: '1px solid rgba(0,0,0,0.08)', boxShadow: '4px 4px 0px var(--c-crimson)' }}>
            <div className="stat__label">{t('central.phcHealth.stats.pendingSync', 'PENDING OR FAILED')}</div>
            <div className="stat__value" style={{ color: totalPending > 0 ? 'var(--c-crimson-dark)' : 'var(--c-success)' }}>
              {totalPending}
            </div>
          </div>
        </div>
      </div>

      {/* PHC Table wrapped in responsive horizontal scroll wrapper */}
      <div className="table-wrapper">
        <table className="table">
          <thead>
            <tr>
              <SortHeader label={t('central.phcHealth.table.colStatus', 'STATUS')} field="status" sortKey={sortConfig.key} sortDir={sortConfig.direction} onSort={handleSort} />
              <SortHeader label={t('central.phcHealth.table.colPhcName', 'PHC NAME')} field="name" sortKey={sortConfig.key} sortDir={sortConfig.direction} onSort={handleSort} />
              <SortHeader label={t('central.phcHealth.table.colPhcCode', 'CODE')} field="phcCode" sortKey={sortConfig.key} sortDir={sortConfig.direction} onSort={handleSort} />
              <SortHeader label={t('central.phcHealth.table.colDistrict', 'DISTRICT')} field="district" sortKey={sortConfig.key} sortDir={sortConfig.direction} onSort={handleSort} />
              <SortHeader label={t('central.phcHealth.table.colLastSync', 'LAST SYNC')} field="lastSyncAt" sortKey={sortConfig.key} sortDir={sortConfig.direction} onSort={handleSort} alignRight={true} />
              <SortHeader label={t('central.phcHealth.table.colCases24h', 'CASES 24H')} field="casesLast24h" sortKey={sortConfig.key} sortDir={sortConfig.direction} onSort={handleSort} alignRight={true} />
              <SortHeader label={t('central.phcHealth.table.colPending', 'PENDING / FAILED')} field="pendingOrFailedCount" sortKey={sortConfig.key} sortDir={sortConfig.direction} onSort={handleSort} alignRight={true} />
            </tr>
          </thead>
          <tbody>
            {processedPhcs.length === 0 ? (
              <tr>
                <td colSpan="7" style={{ textAlign: 'center', padding: 'var(--sp-8)', color: 'var(--c-text-muted)' }} data-testid="phc-empty">
                  {phcList.length === 0
                    ? t('central.phcHealth.table.noneRegistered', 'NO PHC SITES ARE REGISTERED ON THIS SERVER YET. A site appears here once an administrator provisions it.')
                    : t('central.phcHealth.table.empty', 'NO PHCs MATCH THE SELECTED FILTER')}
                </td>
              </tr>
            ) : (
              processedPhcs.map(phc => (
                <PhcRow key={phc.phcId} phc={phc} />
              ))
            )}
          </tbody>
        </table>
      </div>
      </>)}
    </div>
  );
};
