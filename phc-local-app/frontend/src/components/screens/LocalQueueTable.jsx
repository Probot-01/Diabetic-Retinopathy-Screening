import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { localApi } from '../../api/localApiClient';
import { mockAiPredictions } from '../../api/mockData';
import { USE_MOCK_DATA } from '../../config';
import { LoadError } from '../shared/LoadError';
import { DiagnosticResultModal } from './DiagnosticResultModal';

const PIPELINE_CONFIG = {
  captured: {
    stage: 1,
    label: 'CAPTURED',
    badgeClass: 'stage-badge--captured',
    actionText: 'WAITING (QA)',
    actionDisabled: true,
  },
  quality_passed: {
    stage: 2,
    label: 'QUALITY PASS',
    badgeClass: 'stage-badge--pass',
    actionText: 'WAITING (SYNC)',
    actionDisabled: true,
  },
  result_pending: {
    stage: 3,
    label: 'AI PENDING',
    badgeClass: 'stage-badge--pending',
    actionText: 'AI PROCESSING...',
    actionDisabled: true,
  },
  synced: {
    stage: 4,
    label: 'SYNCED, AWAITING AI',
    badgeClass: 'stage-badge--synced',
    actionText: 'WAITING FOR AI',
    actionDisabled: true,
  },
  result_delivered: {
    stage: 5,
    label: 'RESULT READY',
    badgeClass: 'stage-badge--ready',
    actionText: 'VIEW RESULT →',
    actionDisabled: false,
  },
};

export const LocalQueueTable = () => {
  const { t } = useTranslation();
  const [queue, setQueue] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [selectedItem, setSelectedItem] = useState(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const fetchQueue = async () => {
      try {
        const data = await localApi.getQueue();
        if (cancelled) return;
        setQueue(data);
        setLoadError(null);
      } catch (err) {
        // The last good list stays visible, marked stale by the error above it.
        console.error(err);
        if (!cancelled) setLoadError(err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    // A capture's pipeline stage (captured -> quality_passed -> synced) changes
    // in the background (sync manager, central grading) while a technician may
    // just be sitting on this screen — a one-shot fetch on mount never reflects
    // that, and looks exactly like "nothing is happening" even once it has.
    fetchQueue();
    const interval = setInterval(fetchQueue, 5000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  // Handle ESC key for modal
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && isModalOpen) {
        setIsModalOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isModalOpen]);

  const handleOpenResult = (item, e) => {
    e?.stopPropagation();
    setSelectedItem(item);
    setIsModalOpen(true);
  };

  const renderStageIndicator = (status) => {
    const config = PIPELINE_CONFIG[status] || PIPELINE_CONFIG.captured;
    const stageNum = config.stage;

    return (
      <div className="stage-indicator">
        <div className="stage-dots" aria-label={`Stage ${stageNum} of 5: ${config.label}`}>
          {[1, 2, 3, 4, 5].map((dot) => {
            let dotType = 'empty';
            if (dot < stageNum) {
              dotType = 'completed'; // Solid green
            } else if (dot === stageNum) {
              // Current stage: green if delivered/pass, amber if awaiting sync/AI
              dotType = (stageNum === 5 || stageNum === 1 || stageNum === 2) ? 'completed' : 'active';
            }
            return (
              <span
                key={dot}
                className={`stage-dot stage-dot--${dotType}`}
                title={`Stage ${dot} / 5`}
              />
            );
          })}
        </div>
        <div className={`stage-label ${config.badgeClass}`}>
          {config.label}
        </div>
      </div>
    );
  };

  return (
    <div className="section queue-section">
      <div className="u-flex u-justify-between u-items-center u-mb-3">
        <h1 className="t-h1 queue-title">{t('queue.title')}</h1>
        <div className="t-mono" style={{ opacity: 0.6, fontSize: '0.85rem' }}>
          {queue.length} {t('queue.items')}
        </div>
      </div>

      {loadError && (
        <LoadError error={loadError} compact
          title={queue.length ? 'QUEUE NOT REFRESHED — SHOWING THE LAST GOOD LIST' : 'COULD NOT LOAD THE CAPTURE QUEUE'} />
      )}

      <div className="panel queue-panel">
        <div className="queue-table-wrapper">
          <table className="table queue-table">
            <thead>
              <tr>
                <th>{t('queue.colId')}</th>
                <th>{t('queue.colPatient')}</th>
                <th>{t('queue.colCaptured')}</th>
                <th>PIPELINE STAGE</th>
                <th>{t('queue.colAction')}</th>
              </tr>
            </thead>
          <tbody>
            {loading ? (
              [1, 2, 3, 4].map((i) => (
                <tr key={i}>
                  <td colSpan="5">
                    <div className="skeleton" style={{ height: '28px', width: '100%' }}></div>
                  </td>
                </tr>
              ))
            ) : queue.length === 0 && loadError ? (
              <tr>
                <td colSpan="5" className="u-text-center u-p-6">
                  <span className="t-mono" style={{ opacity: 0.5 }}>—</span>
                </td>
              </tr>
            ) : queue.length === 0 ? (
              <tr>
                <td colSpan="5" className="u-text-center u-p-6">
                  <span className="t-mono" style={{ opacity: 0.5 }}>{t('queue.empty')}</span>
                </td>
              </tr>
            ) : (
              queue.map((item) => {
                const config = PIPELINE_CONFIG[item.status] || PIPELINE_CONFIG.captured;
                // Live rows carry no prediction (the PHC never holds a grade), so
                // there is nothing real to open; the modal must never fall back
                // to a fixture result for them.
                const isReady = item.status === 'result_delivered' && (USE_MOCK_DATA || !!item.prediction);

                return (
                  <tr 
                    key={item.captureId} 
                    className={isReady ? "clickable queue-row--ready" : ""}
                    onClick={isReady ? (e) => handleOpenResult(item, e) : undefined}
                  >
                    <td>
                      <span className="t-mono" style={{ opacity: 0.8, fontWeight: 600 }}>
                        {item.captureId.split('-')[1] || item.captureId}
                      </span>
                    </td>
                    <td>
                      <div style={{ fontWeight: 700, fontSize: '14px' }}>{item.patientName}</div>
                      <div className="t-mono" style={{ fontSize: '11px', opacity: 0.5 }}>{item.patientId}</div>
                    </td>
                    <td>
                      <span className="t-mono" style={{ fontSize: '13px' }}>
                        {new Date(item.capturedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </td>
                    <td>
                      {renderStageIndicator(item.status)}
                    </td>
                    <td>
                      {config.actionDisabled || !isReady ? (
                        <button
                          type="button"
                          disabled
                          className="btn-action-col btn-action-col--disabled"
                          title={`Pipeline stage: ${config.label}`}
                        >
                          {config.actionText}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn-action-col btn-action-col--active"
                          onClick={(e) => handleOpenResult(item, e)}
                        >
                          {config.actionText}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
        </div>
      </div>

      {/* Interactive Screening Result Modal */}
      <DiagnosticResultModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        item={selectedItem}
        prediction={selectedItem?.prediction || (USE_MOCK_DATA ? mockAiPredictions.pass : null)}
        imageUrl={selectedItem?.imagePreviewUrl || selectedItem?.imageUrl}
      />
    </div>
  );
};

