import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { centralApi } from '../../api/centralApiClient';
import { drGradeLabels } from '../../api/mockData';
import { USE_MOCK_DATA } from '../../config';
import { InfoBanner } from '../shared/InfoBanner';
import { LoadError } from '../shared/LoadError';

const SortHeader = ({ label, sortKey, currentSort, onRequestSort, width }) => {
  const active = currentSort.key === sortKey;
  const direction = currentSort.direction;

  return (
    <th onClick={() => onRequestSort(sortKey)} style={{ cursor: 'pointer', userSelect: 'none', width: width, transition: 'background 0.2s' }}>
      <div style={{ display: 'inline-flex', alignItems: 'center' }}>
        {label}
        <svg
          width="16" height="16" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          style={{
            marginLeft: '6px',
            opacity: active ? 1 : 0.3,
            transition: 'opacity 0.2s',
          }}
        >
          <g style={{ opacity: active && direction === 'asc' ? 1 : (active ? 0.3 : 0.7) }}>
            <path d="M8 18V6M4 10l4-4 4 4" />
          </g>
          <g style={{ opacity: active && direction === 'desc' ? 1 : (active ? 0.3 : 0.7) }}>
            <path d="M16 6v12M12 14l4 4 4-4" />
          </g>
        </svg>
      </div>
    </th>
  );
};

const SeverityBadge = ({ grade }) => {
  let cls = 'badge badge--neutral';
  let label = 'UNKNOWN';
  if (grade === 0) {
    cls = 'badge badge--pass';
    label = 'LOW';
  } else if (grade === 1 || grade === 2) {
    cls = 'badge badge--warning';
    label = 'MID';
  } else if (grade === 3 || grade === 4) {
    cls = 'badge badge--fail';
    label = 'HIGH';
  }
  return <span className={cls}>{label}</span>;
};

const InfoModal = ({ onClose, t }) => (
  <>
    {/* Backdrop — click outside to dismiss */}
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 9998, background: 'rgba(0,0,0,0.4)' }}
    />
    {/* Centered panel */}
    <div style={{
      position: 'fixed',
      top: '50%', left: '50%',
      transform: 'translate(-50%, -50%)',
      width: '480px', maxWidth: '92vw',
      zIndex: 9999,
      backgroundColor: '#FFF8F0',
      border: '2px solid var(--c-crimson)',
      boxShadow: '12px 12px 0px rgba(0,0,0,0.18)',
      padding: 'var(--sp-5)',
      maxHeight: '80vh', overflowY: 'auto',
    }}>
      <div className="u-flex u-justify-between u-items-center u-mb-4" style={{ borderBottom: '2px solid var(--c-crimson)', paddingBottom: 'var(--sp-3)' }}>
        <h3 className="t-h3" style={{ margin: 0, color: 'var(--c-crimson)', letterSpacing: '1px' }}>
          {t('central.queue.modal.title', 'CLINICAL GUIDANCE')}
        </h3>
        <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontWeight: 'bold', fontSize: '20px', color: 'var(--c-crimson)', lineHeight: 1 }}>✕</button>
      </div>
      <div className="t-mono" style={{ fontSize: '11.5px', display: 'flex', flexDirection: 'column', gap: '13px', lineHeight: '1.6' }}>
        <div><strong style={{ color: 'var(--c-crimson)' }}># PRIORITY:</strong> AI-assigned urgency rank. Cases with higher grades and lower confidence are ranked first.</div>
        <div><strong style={{ color: 'var(--c-crimson)' }}>CAPTURED:</strong> Time elapsed since the fundus image was taken at the PHC. Hover for exact timestamp.</div>
        <div><strong style={{ color: 'var(--c-crimson)' }}>PATIENT REF:</strong> Anonymised patient identifier with age. Used to look up the patient's history.</div>
        <div><strong style={{ color: 'var(--c-crimson)' }}>PHC:</strong> Primary Health Centre — the facility that conducted the screening.</div>
        <div><strong style={{ color: 'var(--c-crimson)' }}>TIER:</strong> Conformal prediction confidence band — <em>A</em> (high certainty, auto-clearable), <em>B</em> (moderate, routine review), <em>C</em> (low certainty, priority manual review).</div>
        <div><strong style={{ color: 'var(--c-crimson)' }}>SEVERITY:</strong> Clinical urgency — LOW (Grade 0: No DR), MID (Grades 1–2: Mild/Moderate NPDR), HIGH (Grades 3–4: Severe NPDR or PDR).</div>
        <div><strong style={{ color: 'var(--c-crimson)' }}>CNN GRADE:</strong> DR grade (0–4) predicted by the holistic deep-learning branch (CNN model trained end-to-end).</div>
        <div><strong style={{ color: 'var(--c-crimson)' }}>RULE ENGINE:</strong> DR grade predicted by counting discrete lesion features (microaneurysms, haemorrhages, exudates) against clinical thresholds.</div>
        <div><strong style={{ color: 'var(--c-crimson)' }}>AGREEMENT:</strong> Whether both AI branches agree. A <em>DISAGREE</em> flag means grades differ — mandatory manual review required before confirming.</div>
        <div><strong style={{ color: 'var(--c-crimson)' }}>CONFIDENCE:</strong> Model certainty score (0–100%). Below 70% warrants extra clinical scrutiny before sign-off.</div>
      </div>
    </div>
  </>
);

const ConfidenceBar = ({ value }) => {
  const pct = Math.round(value * 100);
  const barClass = pct < 70 ? 'bar__fill--danger' : pct < 85 ? 'bar__fill--warning' : 'bar__fill--success';
  return (
    <div className="u-flex u-items-center u-gap-2" style={{ minWidth: '120px' }}>
      <div className="bar" style={{ flex: 1 }}>
        <div className={`bar__fill ${barClass}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="t-mono" style={{ fontSize: 'var(--fs-tiny)', minWidth: '32px' }}>{pct}%</span>
    </div>
  );
};

// A case is "new" for badge purposes for this long after capture — long enough
// to still be on screen when someone jumps from the PHC app to this queue to
// find what they just submitted, short enough that it stops meaning anything
// once the queue has moved on.
const NEW_BADGE_WINDOW_MS = 5 * 60 * 1000;

/**
 * relativeTime(iso, now) -> "just now" | "2 min ago" | "3 hr ago" | ...
 *
 * Takes `now` as a parameter rather than calling Date.now() internally so a
 * ticking `now` state (see the setInterval below) is what actually drives
 * re-renders — otherwise "2 min ago" would freeze at whatever it said when
 * the queue last fetched, even while sitting on screen for the next 10 minutes.
 */
function relativeTime(iso, now) {
  if (!iso) return '';
  const diffMs = now - new Date(iso).getTime();
  const diffSec = Math.round(diffMs / 1000);
  if (diffSec < 5) return 'just now';
  if (diffSec < 60) return `${diffSec} sec ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hr ago`;
  const diffDay = Math.round(diffHr / 24);
  return `${diffDay}d ago`;
}

export const ReviewQueuePage = () => {
  const { t } = useTranslation();
  const [queue, setQueue] = useState([]);
  const [loading, setLoading] = useState(true);
  // Last poll's failure, if any. The previous good queue stays on screen,
  // marked stale; before the first success there is no queue to show at all.
  const [loadError, setLoadError] = useState(null);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [filter, setFilter] = useState('all');
  const [showInfoModal, setShowInfoModal] = useState(false);
  // Respect user settings for initial default sort & compact table view
  const [sortConfig, setSortConfig] = useState(() => {
    try {
      const saved = localStorage.getItem('netrasetu_settings');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.sortListsBy === 'Urgency') return { key: 'urgencyScore', direction: 'desc' };
        if (parsed.sortListsBy === 'Date') return { key: 'capturedAt', direction: 'desc' };
        if (parsed.sortListsBy === 'PHC') return { key: 'phcName', direction: 'asc' };
      }
    } catch (e) {}
    // DEFAULT = the server's priority order (design doc §5.2): Tier C by
    // uncertainty (branch disagreements are forced into Tier C), then Tier B.
    // It used to default to capture time, which threw that ordering away.
    return { key: 'priorityRank', direction: 'asc' };
  });

  const isCompact = localStorage.getItem('netrasetu_compact_table') === 'true';
  const [now, setNow] = useState(() => Date.now());
  const navigate = useNavigate();

  // Ticks the "X min ago" labels and the NEW badge window forward even when no
  // new data has arrived from the 5s queue poll — without this, a case's
  // relative time would freeze at whatever it said on the last fetch that
  // actually changed the queue array (React only re-renders on a new
  // reference), which is misleading on a screen someone is watching live.
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(tick);
  }, []);

  // Search and filter state (matching ReferralTrackerPage pattern)
  const [searchQuery, setSearchQuery] = useState('');
  const [phcFilter, setPhcFilter] = useState('all');
  const [gradeFilter, setGradeFilter] = useState('all');
  const [tierFilter, setTierFilter] = useState(['A', 'B', 'C']);

  useEffect(() => {
    let cancelled = false;
    const fetchQueue = () => {
      centralApi.getOphthQueue().then(data => {
        if (cancelled) return;
        setQueue(data);
        setHasLoaded(true);
        setLoadError(null);
        setLoading(false);
      }).catch(err => {
        if (cancelled) return;
        setLoadError(err);
        setLoading(false);
      });
    };
    // Grading happens asynchronously behind a sync (PHC -> central) that can
    // take up to ~10-30s after a capture, so a one-shot fetch on mount can
    // easily land before a case is ready and then never update — this page
    // has to keep checking, not just load once.
    fetchQueue();
    const interval = setInterval(fetchQueue, 5000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  // Extract unique PHC names for dropdown
  const phcOptions = useMemo(() => {
    return Array.from(new Set(queue.map(q => q.phcName).filter(Boolean))).sort();
  }, [queue]);

  const filteredQueue = useMemo(() => {
    let list = queue;

    // Status filter
    if (filter === 'confirmed') list = list.filter(item => item.reviewStatus === 'confirmed');
    if (filter === 'overridden') list = list.filter(item => item.reviewStatus === 'overridden');
    if (filter === 'pending') list = list.filter(item => item.reviewStatus === 'pending' || !item.reviewStatus);
    if (filter === 'disagree') list = list.filter(item => item.branchAgreement === false);
    if (filter === 'claimed') list = list.filter(item => !!item.claimedBy);

    // PHC filter
    if (phcFilter !== 'all') {
      list = list.filter(item => item.phcName === phcFilter);
    }

    // Grade filter
    if (gradeFilter !== 'all') {
      list = list.filter(item => String(item.drGradeCnn) === String(gradeFilter));
    }

    // Tier filter
    if (tierFilter.length < 3) {
      list = list.filter(item => tierFilter.includes(item.conformalTier));
    }

    // Text search
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter(item =>
        (item.patientName && item.patientName.toLowerCase().includes(q)) ||
        (item.patientReference && item.patientReference.toLowerCase().includes(q)) ||
        (item.phcName && item.phcName.toLowerCase().includes(q)) ||
        (item.caseId && item.caseId.toLowerCase().includes(q))
      );
    }

    return list;
  }, [queue, filter, phcFilter, gradeFilter, searchQuery, tierFilter]);

  const sortedQueue = useMemo(() => {
    let sortableItems = [...filteredQueue];
    if (sortConfig.key !== null) {
      sortableItems.sort((a, b) => {
        let aValue = a[sortConfig.key];
        let bValue = b[sortConfig.key];

        if (sortConfig.key === 'drGradeCnn' || sortConfig.key === 'drGradeRuleEngine') {
          aValue = aValue !== null ? aValue : -1;
          bValue = bValue !== null ? bValue : -1;
        } else if (sortConfig.key === 'branchAgreement') {
          aValue = aValue === true ? 2 : aValue === false ? 1 : 0;
          bValue = bValue === true ? 2 : bValue === false ? 1 : 0;
        } else if (sortConfig.key === 'confidenceScore') {
          aValue = aValue || 0;
          bValue = bValue || 0;
        } else if (typeof aValue === 'string') {
          aValue = aValue.toLowerCase();
          bValue = (bValue || '').toLowerCase();
        }

        if (aValue < bValue) {
          return sortConfig.direction === 'asc' ? -1 : 1;
        }
        if (aValue > bValue) {
          return sortConfig.direction === 'asc' ? 1 : -1;
        }
        return 0;
      });
    }
    return sortableItems;
  }, [filteredQueue, sortConfig]);

  const requestSort = (key) => {
    let direction = 'asc';
    if (sortConfig.key === key && sortConfig.direction === 'asc') {
      direction = 'desc';
    }
    setSortConfig({ key, direction });
  };

  const confirmedCount = queue.filter(q => q.reviewStatus === 'confirmed').length;
  const overriddenCount = queue.filter(q => q.reviewStatus === 'overridden').length;
  const pendingCount = queue.filter(q => q.reviewStatus === 'pending' || !q.reviewStatus).length;
  // Live: the queue lists ONLY cases awaiting review (reviewed ones leave it,
  // api-contracts.md), so "confirmed / overridden" counts and filters could
  // never be anything but 0. Show what the live queue can actually say.
  const disagreeCount = queue.filter(q => q.branchAgreement === false).length;
  const claimedCount = queue.filter(q => q.claimedBy).length;

  const hasActiveFilters = searchQuery.trim() !== '' || phcFilter !== 'all' || gradeFilter !== 'all' || filter !== 'all' || tierFilter.length < 3;

  const handleResetFilters = useCallback(() => {
    setSearchQuery('');
    setPhcFilter('all');
    setGradeFilter('all');
    setFilter('all');
    setTierFilter(['A', 'B', 'C']);
    setSortConfig({ key: 'priorityRank', direction: 'asc' });
  }, []);

  if (loading) {
    return (
      <div className="section">
        <div className="skeleton" style={{ height: '40px', width: '300px', marginBottom: 'var(--sp-4)' }} />
        {[...Array(5)].map((_, i) => (
          <div key={i} className="skeleton" style={{ height: '60px', marginBottom: 'var(--sp-2)' }} />
        ))}
      </div>
    );
  }

  if (loadError && !hasLoaded) {
    return (
      <div className="section">
        <LoadError error={loadError} what="the review queue" />
        <p className="t-mono" style={{ fontSize: 'var(--fs-tiny)' }}>Retrying every 5 seconds.</p>
      </div>
    );
  }

  return (
    <div className="section">
      {loadError && (
        <LoadError error={loadError} what="the latest review queue"
          compact />
      )}
      {loadError && (
        <p className="t-mono u-mb-4" style={{ fontSize: 'var(--fs-tiny)', color: 'var(--c-crimson)' }}>
          The list below is from the last successful refresh and may be out of date. Retrying every 5 seconds.
        </p>
      )}
      <div className="u-flex u-items-center u-justify-between u-mb-6">
        <div>
          <p className="section__subtitle">{t('central.queue.subtitle', 'OPHTHALMOLOGIST INTERFACE')}</p>
          <div className="u-flex u-items-center u-gap-3">
            <h1 className="section__title" style={{ marginBottom: 0 }}>{t('central.queue.title', 'CASES')}</h1>
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
              <button
                onClick={() => setShowInfoModal(!showInfoModal)}
                title="Clinical Guidance Info"
                style={{
                  background: 'transparent',
                  border: '2px solid var(--c-crimson)',
                  color: 'var(--c-crimson)',
                  borderRadius: '50%',
                  width: '28px',
                  height: '28px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '14px',
                  fontWeight: 'bold',
                  fontFamily: 'serif',
                  cursor: 'pointer',
                  marginLeft: '4px',
                  transition: 'background 0.2s',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(204, 0, 0, 0.1)' }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
              >
                i
              </button>
              {showInfoModal && <InfoModal onClose={() => setShowInfoModal(false)} t={t} />}
            </div>
          </div>
        </div>
        <div className="u-flex u-items-center u-gap-3">
          <span className="badge badge--neutral" data-testid="queue-total">{queue.length} {t('central.queue.stats.total', 'AWAITING REVIEW')}</span>
          {USE_MOCK_DATA ? (
            <>
              <span className="badge badge--pass">{confirmedCount} {t('central.queue.stats.confirmed', 'CONFIRMED')}</span>
              <span className="badge badge--warning">{overriddenCount} {t('central.queue.stats.overridden', 'OVERRIDDEN')}</span>
              {pendingCount > 0 && <span className="badge badge--fail">{pendingCount} {t('central.queue.stats.pending', 'PENDING')}</span>}
            </>
          ) : (
            <>
              <span className="badge badge--fail" data-testid="queue-disagree">{disagreeCount} BRANCH DISAGREEMENT{disagreeCount === 1 ? '' : 'S'}</span>
              <span className="badge badge--warning" data-testid="queue-claimed">{claimedCount} CLAIMED</span>
            </>
          )}
        </div>
      </div>

      {/* Search & Multi-Filter Bar (matching ReferralTrackerPage) */}
      <div className="panel panel--premium u-mb-4" style={{ padding: 'var(--sp-4)', border: 'var(--border)' }}>
        <div className="u-flex u-items-center u-gap-3" style={{ flexWrap: 'wrap' }}>
          {/* Search Input */}
          <div style={{ flex: '1 1 200px', minWidth: '180px' }}>
            <input
              type="text"
              className="input"
              placeholder={t('central.queue.search.placeholder', '🔍 Search Patient Ref, Case ID, or PHC...')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{ height: '38px', fontSize: 'var(--fs-tiny)' }}
            />
          </div>

          {/* PHC Filter Dropdown */}
          <div style={{ width: '160px' }}>
            <select
              className="select"
              value={phcFilter}
              onChange={(e) => setPhcFilter(e.target.value)}
              style={{ height: '38px', fontSize: 'var(--fs-tiny)' }}
            >
              <option value="all">{t('central.queue.search.allPhcs', 'ALL PHCs')}</option>
              {phcOptions.map(p => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>

          {/* Grade Filter Dropdown */}
          <div style={{ width: '150px' }}>
            <select
              className="select"
              value={gradeFilter}
              onChange={(e) => setGradeFilter(e.target.value)}
              style={{ height: '38px', fontSize: 'var(--fs-tiny)' }}
            >
              <option value="all">{t('central.queue.search.allGrades', 'ALL GRADES')}</option>
              <option value="4">Grade 4 (PDR)</option>
              <option value="3">Grade 3 (Severe)</option>
              <option value="2">Grade 2 (Moderate)</option>
              <option value="1">Grade 1 (Mild)</option>
              <option value="0">Grade 0 (No DR)</option>
            </select>
          </div>

          {/* Tier Filter Checkboxes */}
          <div className="u-flex u-items-center u-gap-2" style={{ padding: '0 12px', border: '1px solid var(--border)', borderRadius: '4px', height: '38px', background: 'var(--bg-panel)' }}>
            <span style={{ fontSize: 'var(--fs-tiny)', fontWeight: 600, opacity: 0.7 }}>TIERS:</span>
            {['A', 'B', 'C'].map(tier => (
              <label key={tier} className="u-flex u-items-center u-gap-1" style={{ fontSize: 'var(--fs-tiny)', cursor: 'pointer', margin: 0 }}>
                <input
                  type="checkbox"
                  checked={tierFilter.includes(tier)}
                  onChange={(e) => {
                    if (e.target.checked) setTierFilter([...tierFilter, tier]);
                    else setTierFilter(tierFilter.filter(t => t !== tier));
                  }}
                  style={{ cursor: 'pointer', accentColor: 'var(--c-crimson)' }}
                />
                {tier}
              </label>
            ))}
          </div>

          {/* Mismatch Chip removed as per request */}

          {/* Reset Filters */}
          {hasActiveFilters && (
            <button
              className="btn btn--secondary"
              style={{ height: '38px', padding: '0 12px', fontSize: 'var(--fs-tiny)' }}
              onClick={handleResetFilters}
              title="Reset all active search and filters"
            >
              {t('central.queue.search.reset', 'RESET (✕)')}
            </button>
          )}
        </div>
      </div>

      {/* Filter Bar */}
      <div className="queue-filter-bar u-mb-4">
        {(USE_MOCK_DATA ? [
          { id: 'all', label: t('central.queue.filters.all', 'ALL CASES') },
          { id: 'confirmed', label: t('central.queue.filters.confirmed', 'CONFIRMED CASES') },
          { id: 'overridden', label: t('central.queue.filters.overridden', 'OVERRIDDEN CASES') },
          { id: 'pending', label: t('central.queue.filters.pending', 'PENDING CASES') },
        ] : [
          { id: 'all', label: t('central.queue.filters.all', 'ALL CASES') },
          { id: 'disagree', label: 'BRANCH DISAGREEMENTS' },
          { id: 'claimed', label: 'CLAIMED BY A REVIEWER' },
        ]).map(f => (
          <button
            key={f.id}
            className={`queue-filter-btn ${filter === f.id ? 'queue-filter-btn--active' : ''}`}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Queue Table */}
      <div className="table-wrapper">
        <table className={`table ${isCompact ? 'table--compact' : ''}`}>
          <thead>
            <tr>
              <SortHeader width="40px" label={t('central.queue.table.colPriority', '#')} sortKey="priorityRank" currentSort={sortConfig} onRequestSort={requestSort} />
              <SortHeader label={t('central.queue.table.colCaptured', 'CAPTURED')} sortKey="capturedAt" currentSort={sortConfig} onRequestSort={requestSort} />
              <th>{t('central.queue.table.colPatientRef', 'PATIENT REF')}</th>
              <th>{t('central.queue.table.colPhc', 'PHC')}</th>
              <SortHeader label={t('central.queue.table.colTier', 'TIER')} sortKey="conformalTier" currentSort={sortConfig} onRequestSort={requestSort} />
              <SortHeader label={t('central.queue.table.colSeverity', 'SEVERITY')} sortKey="drGradeCnn" currentSort={sortConfig} onRequestSort={requestSort} />
              <SortHeader label={t('central.queue.table.colCnnGrade', 'CNN GRADE')} sortKey="drGradeCnn" currentSort={sortConfig} onRequestSort={requestSort} />
              <SortHeader label={t('central.queue.table.colRuleEngine', 'RULE ENGINE')} sortKey="drGradeRuleEngine" currentSort={sortConfig} onRequestSort={requestSort} />
              <SortHeader label={t('central.queue.table.colAgreement', 'AGREEMENT')} sortKey="branchAgreement" currentSort={sortConfig} onRequestSort={requestSort} />
              <SortHeader label={t('central.queue.table.colConfidence', 'CONFIDENCE')} sortKey="confidenceScore" currentSort={sortConfig} onRequestSort={requestSort} />
              <th>{t('central.queue.table.colClaimedBy', 'CLAIMED BY')}</th>
              {/* Triage urgency: an ordering HINT inside the tier, not a
                  clinical score. The header carries the caveat so it is
                  visible without hovering a single row. */}
              <SortHeader
                label={t('central.queue.table.colUrgency', 'URGENCY *')}
                sortKey="urgencyScore"
                currentSort={sortConfig}
                onRequestSort={requestSort}
              />
            </tr>
          </thead>
          <tbody>
            {sortedQueue.map((item, idx) => {
              const isNew = item.capturedAt && (now - new Date(item.capturedAt).getTime()) < NEW_BADGE_WINDOW_MS;
              return (
              <tr
                key={item.caseId}
                className="clickable"
                onClick={() => navigate(`/ophth/case/${item.caseId}`)}
                style={{
                  ...(item.branchAgreement === false ? { borderLeft: '3px solid var(--c-crimson-dark)' } : {}),
                  ...(isNew ? { background: 'rgba(46, 160, 67, 0.08)' } : {}),
                }}
              >
                <td className="t-mono" style={{ opacity: 0.4 }}>{item.priorityRank}</td>
                <td title={new Date(item.capturedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}>
                  <div className="u-flex u-items-center u-gap-2">
                    <span className="t-mono" style={{ fontWeight: 700 }}>{relativeTime(item.capturedAt, now)}</span>
                    {isNew && (
                      <span
                        className="badge badge--pass badge--new-pulse"
                        style={{ fontSize: '10px', padding: '1px 6px' }}
                      >
                        NEW
                      </span>
                    )}
                  </div>
                </td>
                <td>
                  <div style={{ fontWeight: 700, fontSize: '14px', color: 'var(--text-h)' }}>
                    {item.patientName || item.patientReference}
                  </div>
                  <div className="t-mono" style={{ fontSize: '11px', opacity: 0.6 }}>
                    {item.patientName ? item.patientReference : ''}{item.patientName && item.patientAge ? ' • ' : ''}{item.patientAge ? `${item.patientAge}Y` : ''}
                  </div>
                </td>
                <td className="t-mono">{item.phcName}</td>
                <td className="t-mono" style={{ fontWeight: 700 }}>
                  {item.conformalTier ? `Tier ${item.conformalTier}` : '—'}
                </td>
                <td><SeverityBadge grade={item.drGradeCnn} /></td>
                <td>
                  <span className="t-mono" style={{ fontWeight: 700 }}>
                    {t('central.queue.table.grade', 'Grade')} {item.drGradeCnn}
                  </span>
                  <br />
                  <span className="t-label" style={{ opacity: 0.5 }}>
                    {drGradeLabels[item.drGradeCnn] || '—'}
                  </span>
                </td>
                <td>
                  {item.drGradeRuleEngine !== null ? (
                    <>
                      <span className="t-mono" style={{ fontWeight: 700 }}>
                        {t('central.queue.table.grade', 'Grade')} {item.drGradeRuleEngine}
                      </span>
                      <br />
                      <span className="t-label" style={{ opacity: 0.5 }}>
                        {drGradeLabels[item.drGradeRuleEngine] || '—'}
                      </span>
                    </>
                  ) : (
                    <span className="t-mono" style={{ opacity: 0.3 }}>{t('central.queue.table.notAvailable', 'NOT YET AVAILABLE')}</span>
                  )}
                </td>
                <td>
                  {item.branchAgreement === null ? (
                    <span className="t-mono" style={{ opacity: 0.3 }}>{t('central.queue.table.na', 'N/A')}</span>
                  ) : item.branchAgreement ? (
                    <span className="badge badge--pass">{t('central.queue.table.agree', '✓ AGREE')}</span>
                  ) : (
                    <span className="badge badge--fail">{t('central.queue.table.disagree', '⚠ DISAGREE')}</span>
                  )}
                </td>
                <td><ConfidenceBar value={item.confidenceScore} /></td>
                {/* §10.8: who holds this case right now, shown BEFORE it is
                    opened so a reviewer does not walk into a case they cannot
                    act on. null = free. */}
                <td className="t-mono" data-testid="claimed-by-cell">
                  {item.claimedBy
                    ? <span className="badge badge--warning" title={item.claimedAt ? `since ${new Date(item.claimedAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })}` : undefined}>● {item.claimedBy.name || 'ANOTHER REVIEWER'}</span>
                    : <span style={{ opacity: 0.35 }}>—</span>}
                </td>
                {/* Urgency: ordering hint only. Rendered muted and with the
                    limitation on hover so it never reads as a clinical score,
                    and "--" for not-computed so a blank cell is not mistaken
                    for low urgency. */}
                <td
                  className="t-mono"
                  title={item.urgencyLimitation
                    || 'Not computed: the clinical inputs (age, years diabetic, HbA1c) were not all available. This is not a low-urgency result.'}
                  style={{ opacity: item.urgencyScore == null ? 0.35 : 0.85 }}
                >
                  {item.urgencyScore == null ? '--' : (
                    <>
                      <span style={{ fontWeight: 700 }}>{item.urgencyScore}</span>
                      {item.urgencyTopFactor && (
                        <span style={{ fontSize: '10px', opacity: 0.6, marginLeft: 4 }}>
                          {item.urgencyTopFactor}
                        </span>
                      )}
                    </>
                  )}
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* The caveat the * points at. Stated here, in the open, rather than
          only in a tooltip: a 1-100 number in a clinical queue reads as
          evidence unless something says otherwise, and this one is a
          re-expression of an assumption -- the model behind it is trained on
          synthetic data and has never been validated against an outcome. */}
      <div
        className="u-p-3"
        style={{ fontSize: '11px', opacity: 0.65, borderTop: 'var(--border)' }}
      >
        {t('central.queue.urgencyFootnote',
          '* URGENCY is a queue-ordering hint only. It comes from a model trained '
          + 'on synthetic data and has never been validated against patient '
          + 'outcomes — it is not a clinical assessment, and it does not affect '
          + 'the review tier or the referral decision. "--" means it was not '
          + 'computed because age, years diabetic or HbA1c was missing; that is '
          + 'not a low-urgency result.')}
      </div>

      {sortedQueue.length === 0 && (
        <div className="u-text-center u-p-6" style={{ border: 'var(--border)', borderTop: 'none' }}>
          <p className="t-mono" style={{ opacity: 0.4 }}>{t('central.queue.empty', 'NO CASES MATCH FILTER')}</p>
        </div>
      )}
    </div>
  );
};
