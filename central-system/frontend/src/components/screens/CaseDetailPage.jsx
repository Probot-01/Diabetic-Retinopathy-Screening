import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { centralApi } from '../../api/centralApiClient';
import { drGradeLabels } from '../../api/mockData';
import { GradCamOverlay } from './GradCamOverlay';
import { LesionEvidencePanel } from './LesionEvidencePanel';
import { BranchComparisonPanel } from './BranchComparisonPanel';
import { DecisionControls } from './DecisionControls';
import { CaseHistoryTimeline } from './CaseHistoryTimeline';
import { InfoBanner } from '../shared/InfoBanner';
import { LoadError } from '../shared/LoadError';

const MetricBar = ({ label, value, maxVal = 1, color = 'var(--c-crimson)' }) => {
  const pct = Math.round((value / maxVal) * 100);
  return (
    <div className="u-mb-4">
      <div className="u-flex u-justify-between u-items-center" style={{ marginBottom: 'var(--sp-1)' }}>
        <span className="t-label">{label}</span>
        <span className="t-mono" style={{ fontWeight: 700, fontSize: 'var(--fs-small)' }}>
          {typeof value === 'number' ? `${pct}%` : 'N/A'}
        </span>
      </div>
      <div className="bar">
        <div className="bar__fill" style={{ width: value !== null ? `${pct}%` : '0%', background: color }} />
      </div>
    </div>
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
  return <span className={cls}>SEVERITY: {label}</span>;
};

export const CaseDetailPage = () => {
  const { caseId } = useParams();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [caseData, setCaseData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showGradCam, setShowGradCam] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [reviewSubmitted, setReviewSubmitted] = useState(false);
  const [claimedBy, setClaimedBy] = useState(null);
  const [priorReview, setPriorReview] = useState(null);
  // Failures, kept apart: without the case there is nothing to show; a failed
  // claim or review-history call is shown next to the case, not hidden.
  const [loadError, setLoadError] = useState(null);
  const [sideErrors, setSideErrors] = useState([]);
  const [reloadKey, setReloadKey] = useState(0);
  const startTimeRef = useRef(Date.now());

  useEffect(() => {
    let cancelled = false;
    startTimeRef.current = Date.now();
    setLoading(true);
    setLoadError(null);
    setSideErrors([]);
    const noteSideError = (what) => (err) => {
      if (!cancelled) setSideErrors(prev => [...prev, { what, err }]);
    };

    Promise.all([
      centralApi.getCaseDetail(caseId),
      centralApi.claimCase(caseId).catch(err => {
        if (err.status === 409) setClaimedBy(err.claimedBy || 'Another Reviewer');
        else noteSideError('COULD NOT CLAIM THIS CASE — another reviewer may open it too')(err);
      }),
      centralApi.getReviews(caseId).then(reviews => {
        if (reviews && reviews.length > 0) setPriorReview(reviews[0]);
      }).catch(noteSideError('COULD NOT LOAD THE REVIEW HISTORY — a prior review may exist')),
    ]).then(([data]) => {
      if (cancelled) return;
      setCaseData(data);
      setLoading(false);
    }).catch(err => {
      if (cancelled) return;
      setLoadError(err);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [caseId, reloadKey]);

  const handleReviewSubmit = async (reviewData) => {
    const durationSec = Math.round((Date.now() - startTimeRef.current) / 1000);
    await centralApi.submitReview(caseId, {
      ...reviewData,
      reviewDurationSeconds: durationSec,
    });
    setReviewSubmitted(true);
    setTimeout(() => navigate('/ophth/queue'), 1500);
  };

  if (loading) {
    return (
      <div className="section">
        <div className="skeleton" style={{ height: '40px', width: '400px', marginBottom: 'var(--sp-6)' }} />
        <div className="grid--2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0 }}>
          <div className="skeleton" style={{ height: '500px' }} />
          <div className="skeleton" style={{ height: '500px' }} />
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="section">
        <LoadError error={loadError} what={`case ${String(caseId).slice(0, 8).toUpperCase()}`}
          onRetry={() => setReloadKey(k => k + 1)} />
        <button className="btn btn--outline" onClick={() => navigate('/ophth/queue')}>
          ← {t('central.caseDetail.nav.queue', 'CASES')}
        </button>
      </div>
    );
  }

  if (!caseData) {
    return <div className="section"><p className="t-mono">{t('central.caseDetail.notFound', 'Case not found.')}</p></div>;
  }

  const c = caseData;
  const isBranchMismatch = c.branchAgreement === false;

  return (
    <div className={`section case-detail ${reviewSubmitted ? 'case-detail--submitted' : ''}`}>
      {sideErrors.map(({ what, err }) => (
        <LoadError key={what} error={err} title={what} compact />
      ))}
      {/* Top Bar — Case ID + Tier + Mismatch Warning */}
      <div className={`case-detail__top-bar ${isBranchMismatch ? 'case-detail__top-bar--mismatch' : ''}`}>
        <div className="u-flex u-items-center u-gap-4">
          <button className="btn btn--outline" onClick={() => navigate('/ophth/queue')} style={{ padding: 'var(--sp-2) var(--sp-3)' }}>
            <span>← {t('central.caseDetail.nav.queue', 'CASES')}</span>
          </button>
          <div>
            <span className="t-mono" style={{ fontSize: 'var(--fs-small)', opacity: 0.5 }}>{t('central.caseDetail.caseLabel', 'CASE')}</span>
            <span className="t-mono" style={{ fontWeight: 700, marginLeft: 'var(--sp-2)' }}>
              #{caseId.slice(0, 8).toUpperCase()}
            </span>
            <span className="t-mono" style={{ fontWeight: 700, marginLeft: 'var(--sp-3)', color: 'var(--c-crimson)' }}>
              • {c.patientName ? `${c.patientName.toUpperCase()}` : c.patientReference} {c.patientAge ? `(${c.patientAge}Y)` : ''}
            </span>
          </div>
        </div>

        <div className="u-flex u-items-center u-gap-4">
          <SeverityBadge grade={c.drGradeCnn} />
          {isBranchMismatch && (
            <span className="badge badge--fail case-detail__mismatch-badge">
              {t('central.caseDetail.mismatchWarning', '⚠ BRANCH MISMATCH — REVIEW REQUIRED')}
            </span>
          )}
        </div>
      </div>

      <InfoBanner title={t('central.caseDetail.banner.title', 'CLINICAL REVIEW GUIDANCE')}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div><strong style={{ color: 'var(--c-crimson)' }}>CONFIDENCE:</strong> The confidence score shows the model's certainty. Lower scores should be scrutinized closely.</div>
          <div><strong style={{ color: 'var(--c-crimson)' }}>UNCERTAINTY:</strong> Measures the model's epistemic uncertainty regarding the grade.</div>
          <div><strong style={{ color: 'var(--c-crimson)' }}>CONSISTENCY:</strong> Lesion-attention consistency ensures the model is looking at valid physiological features (like microaneurysms) rather than artifacts.</div>
          <div><strong style={{ color: 'var(--c-crimson)' }}>BRANCH MISMATCH:</strong> If the CNN and Rule Engine disagree, you must resolve this manually by providing a clinical reason.</div>
          <div><strong style={{ color: 'var(--c-crimson)' }}>GRAD-CAM:</strong> Use the Grad-CAM toggle to verify where the model is placing its attention on the fundus image.</div>
        </div>
      </InfoBanner>

      {/* Main Content Grid */}
      <div className="case-detail__grid">
        {/* LEFT COLUMN — Image + Metrics */}
        <div className="case-detail__left">
          {/* Fundus Image with Grad-CAM Toggle */}
          <div className="case-detail__image-panel panel--dark">
            <div className="case-detail__image-header u-flex u-justify-between u-items-center">
              <span className="t-label" style={{ color: 'var(--c-crimson)' }}>
                {t('central.caseDetail.image.fundus', 'FUNDUS IMAGE')} — {c.patientName ? `${c.patientName} (${c.patientReference})` : c.patientReference}
              </span>
              <button
                className={`btn ${showGradCam ? 'btn--danger' : 'btn--outline'}`}
                onClick={() => setShowGradCam(!showGradCam)}
                style={{ padding: 'var(--sp-1) var(--sp-3)', fontSize: 'var(--fs-tiny)' }}
              >
                <span>{showGradCam ? t('central.caseDetail.image.gradCamOn', '✦ GRAD-CAM ON') : t('central.caseDetail.image.gradCamOff', '○ GRAD-CAM OFF')}</span>
              </button>
            </div>
            <GradCamOverlay showOverlay={showGradCam} caseData={c} />
          </div>

          {/* Metric Bars */}
          <div className="case-detail__metrics" style={{ padding: 'var(--sp-6)', border: 'var(--border)' }}>
            <MetricBar
              label={t('central.caseDetail.metrics.confidence', 'CONFIDENCE')}
              value={c.confidenceScore}
              color={c.confidenceScore > 0.85 ? 'var(--c-success)' : c.confidenceScore > 0.7 ? 'var(--c-warning)' : 'var(--c-crimson)'}
            />
            <MetricBar
              label={t('central.caseDetail.metrics.uncertainty', 'UNCERTAINTY')}
              value={c.uncertaintyScore}
              color="var(--c-warning)"
            />
            <MetricBar
              label={t('central.caseDetail.metrics.lesionConsistency', 'LESION-ATTENTION CONSISTENCY')}
              value={c.lesionAttentionConsistencyScore}
              color={c.lesionAttentionConsistencyScore !== null && c.lesionAttentionConsistencyScore > 0.6 ? 'var(--c-success)' : 'var(--c-crimson)'}
            />
          </div>
        </div>

        {/* RIGHT COLUMN — Grading + Evidence + Context */}
        <div className="case-detail__right">
          {/* Branch Comparison */}
          <BranchComparisonPanel caseData={c} />

          {/* Lesion Evidence */}
          <LesionEvidencePanel caseData={c} />

          {/* Patient / Capture Context */}
          <div className="case-detail__context" style={{ border: 'var(--border)', padding: 'var(--sp-6)' }}>
            <h3 className="t-h3 u-mb-4">{t('central.caseDetail.context.title', 'PATIENT / CAPTURE CONTEXT')}</h3>
            <div className="grid--2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0 }}>
              <div style={{ padding: 'var(--sp-3)', borderRight: 'var(--border)', borderBottom: 'var(--border)' }}>
                <span className="t-label" style={{ opacity: 0.5 }}>PATIENT NAME</span>
                <p className="t-mono" style={{ fontWeight: 700, color: 'var(--c-crimson)' }}>
                  {c.patientName || 'Krrish'}
                </p>
              </div>
              <div style={{ padding: 'var(--sp-3)', borderBottom: 'var(--border)' }}>
                <span className="t-label" style={{ opacity: 0.5 }}>PATIENT AGE</span>
                <p className="t-mono" style={{ fontWeight: 700 }}>
                  {c.patientAge ? `${c.patientAge} YEARS` : '20 YEARS'}
                </p>
              </div>
              <div style={{ padding: 'var(--sp-3)', borderRight: 'var(--border)' }}>
                <span className="t-label" style={{ opacity: 0.5 }}>{t('central.caseDetail.context.diabetesDuration', 'DIABETES DURATION')}</span>
                <p className="t-mono" style={{ fontWeight: 700 }}>
                  {c.questionnaireData?.riskFactors?.yearsSinceDiagnosis
                    ? { lt1: '< 1 year', '1to5': '1–5 years', '5to10': '5–10 years', gt10: '> 10 years' }[c.questionnaireData.riskFactors.yearsSinceDiagnosis]
                    : 'N/A'}
                </p>
              </div>
              <div style={{ padding: 'var(--sp-3)' }}>
                <span className="t-label" style={{ opacity: 0.5 }}>{t('central.caseDetail.context.bloodPressure', 'BLOOD PRESSURE')}</span>
                <p className="t-mono" style={{ fontWeight: 700, textTransform: 'uppercase' }}>
                  {c.questionnaireData?.riskFactors?.bloodPressure || 'N/A'}
                </p>
              </div>
              <div style={{ padding: 'var(--sp-3)', borderRight: 'var(--border)', borderTop: 'var(--border)' }}>
                <span className="t-label" style={{ opacity: 0.5 }}>{t('central.caseDetail.context.pupilStatus', 'PUPIL STATUS')}</span>
                <p className="t-mono" style={{ fontWeight: 700, textTransform: 'uppercase' }}>
                  {c.captureMetadata?.pupilStatus || 'N/A'}
                </p>
              </div>
              <div style={{ padding: 'var(--sp-3)', borderTop: 'var(--border)' }}>
                <span className="t-label" style={{ opacity: 0.5 }}>{t('central.caseDetail.context.cameraDevice', 'CAMERA DEVICE')}</span>
                <p className="t-mono" style={{ fontWeight: 700 }}>
                  {c.captureMetadata?.cameraDeviceReported?.replace(/_/g, ' ').toUpperCase() || 'N/A'}
                </p>
              </div>
              <div style={{ padding: 'var(--sp-3)', borderRight: 'var(--border)', borderTop: 'var(--border)' }}>
                <span className="t-label" style={{ opacity: 0.5 }}>{t('central.caseDetail.context.workerRating', 'WORKER RATING')}</span>
                <p className="t-mono" style={{ fontWeight: 700, textTransform: 'uppercase' }}>
                  {c.captureMetadata?.workerUsabilityRating || 'N/A'}
                </p>
              </div>
              <div style={{ padding: 'var(--sp-3)', borderTop: 'var(--border)' }}>
                <span className="t-label" style={{ opacity: 0.5 }}>{t('central.caseDetail.context.symptoms', 'SYMPTOMS')}</span>
                <p className="t-mono" style={{ fontWeight: 700, fontSize: 'var(--fs-tiny)' }}>
                  {c.questionnaireData?.symptoms
                    ? Object.entries(c.questionnaireData.symptoms)
                        .filter(([, v]) => v)
                        .map(([k]) => k.replace(/([A-Z])/g, ' $1').trim().toUpperCase())
                        .join(', ') || 'NONE'
                    : 'N/A'}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom — Decision Controls + History */}
      <div className="case-detail__bottom">
        <DecisionControls
          caseData={c}
          onSubmit={handleReviewSubmit}
          submitted={reviewSubmitted}
          claimedBy={claimedBy}
          priorReview={priorReview}
        />

        <div style={{ marginTop: 'var(--sp-4)' }}>
          <button
            className="btn btn--outline u-w-full"
            onClick={() => setShowHistory(!showHistory)}
            style={{ justifyContent: 'center' }}
          >
            <span>{showHistory ? t('central.caseDetail.history.hide', '▼ HIDE HISTORY') : t('central.caseDetail.history.show', '▶ SHOW PATIENT HISTORY')} ({c.priorAssessments?.length || 0} {t('central.caseDetail.history.prior', 'prior')})</span>
          </button>
          {showHistory && <CaseHistoryTimeline priorAssessments={c.priorAssessments || []} />}
        </div>
      </div>

      {/* Success overlay */}
      {reviewSubmitted && (
        <div className="case-detail__success-overlay">
          <div className="case-detail__success-content">
            <span style={{ fontSize: '4rem' }}>✓</span>
            <h2 className="t-h2">{t('central.caseDetail.success.title', 'REVIEW SUBMITTED')}</h2>
            <p className="t-mono" style={{ opacity: 0.6 }}>{t('central.caseDetail.success.subtitle', 'REDIRECTING TO CASES...')}</p>
          </div>
        </div>
      )}
    </div>
  );
};
