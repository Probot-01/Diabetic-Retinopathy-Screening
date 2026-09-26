import React, { useState, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { QualityResultPanel } from './QualityResultPanel';
import { CaptureMetadataForm } from './CaptureMetadataForm';
// PatientQuestionnaireForm removed — questionnaire is now collected at registration
import { RetinalImageViewer } from './RetinalImageViewer';
import { localApi } from '../../api/localApiClient';
import { USE_MOCK_DATA } from '../../config';
import { mockAiPredictions } from '../../api/mockData';
import { LoadError } from '../shared/LoadError';
import demoFundusImg from '../../assets/fundus_eye.jpg';

export const CaptureScreen = () => {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const patientId = searchParams.get('patientId') || 'UNKNOWN_PATIENT';
  // The fictional 'Krrish, 20' stand-in is mock-mode only; live mode shows
  // what it actually knows about the patient, even if that is nothing.
  const patientName = searchParams.get('name') || (() => {
    try {
      const p = JSON.parse(localStorage.getItem('netra_latest_patient'));
      return p?.name;
    } catch (e) { return null; }
  })() || (USE_MOCK_DATA ? 'Krrish' : '');
  const patientAge = searchParams.get('age') || (() => {
    try {
      const p = JSON.parse(localStorage.getItem('netra_latest_patient'));
      return p?.age;
    } catch (e) { return null; }
  })() || (USE_MOCK_DATA ? '20' : '');

  const [activeStep, setActiveStep] = useState(1);
  const [imageFile, setImageFile] = useState(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState(null);
  const [qualityResult, setQualityResult] = useState(null);
  const [metadata, setMetadata] = useState({ eye: 'right' });
  // questionnaire is collected during patient registration (PatientRegistrationForm)
  const [questionnaire] = useState(() => {
    try {
      const p = JSON.parse(localStorage.getItem('netra_latest_patient'));
      return p?.questionnaire || {};
    } catch (e) {
      return {};
    }
  });
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  // { title, err } for whichever live request last failed; shown in place of
  // a result, never replaced by one.
  const [stepError, setStepError] = useState(null);
  const [mockScenario, setMockScenario] = useState('pass');

  const fileInputRef = useRef(null);

  const handleCaptureClick = () => {
    if (fileInputRef.current && !imageFile) {
      fileInputRef.current.click();
    }
  };

  const handleFileChange = (e) => {
    const file = e.target.files[0];
    if (file) {
      setImageFile(file);
      setImagePreviewUrl(URL.createObjectURL(file));
    }
  };

  const handleLoadDemoImage = async (e) => {
    e?.stopPropagation();
    try {
      const response = await fetch(demoFundusImg);
      const blob = await response.blob();
      const file = new File([blob], 'demo_fundus_retina.png', { type: 'image/png' });
      setImageFile(file);
      setImagePreviewUrl(demoFundusImg);
    } catch (err) {
      console.warn("Could not load demo fundus image:", err);
    }
  };

  const runQualityCheck = async () => {
    if (!imageFile) return;

    setIsAnalyzing(true);
    setStepError(null);
    try {
      // ── Real local quality gate (phc-local-app/backend POST /captures) ──
      // Runs locally on the PHC node/MATLAB quality gate engine.
      // Under system-design-v4.md §1.2 & §1.3, local does image-quality gating ONLY;
      // DR diagnostic grading happens centrally, not at the PHC.
      // Mock mode: returns null. Live mode: a result, or it throws.
      const realCapture = await localApi.submitCapture(
        patientId, imageFile, metadata.cameraDeviceId || 'unknown');

      let uiStatus, issues, captureIdToUse, retakeCount, qualityMetrics, qualityScore;

      if (realCapture) {
        // Exactly what the gate returned. The contract's response carries a
        // status and a reason, not a score or per-metric numbers, so those
        // stay null and QualityResultPanel leaves them out.
        uiStatus = realCapture.qualityStatus;
        issues = realCapture.qualityReason ? [realCapture.qualityReason] : [];
        captureIdToUse = realCapture.captureId;
        retakeCount = realCapture.retakeCount;
        qualityScore = realCapture.qualityScore ?? null;
        qualityMetrics = realCapture.metrics ?? null;
      } else {
        // MOCK MODE ONLY: scenario fixtures (submitCapture returns null only in mock mode).
        await new Promise(r => setTimeout(r, 600));
        const mockDataScenario = mockAiPredictions[mockScenario] || mockAiPredictions.pass;
        const apiStatus = mockDataScenario.imageQuality?.status || 'good';
        uiStatus = apiStatus === 'good' ? 'pass' : (apiStatus === 'borderline' ? 'borderline' : 'retake');
        issues = mockDataScenario.imageQuality?.issues || [];
        captureIdToUse = `CAPT-${Date.now()}`;
        retakeCount = undefined;
        qualityScore = mockDataScenario.imageQuality?.qualityScore ?? (uiStatus === 'pass' ? 0.91 : (uiStatus === 'borderline' ? 0.58 : 0.28));
        qualityMetrics = mockDataScenario.imageQuality?.metrics || {
          focusScore: 0.94,
          illuminationScore: 0.88,
          contrastScore: 0.86,
          retinalCoverageScore: 0.98,
        };
      }

      setQualityResult({
        captureId: captureIdToUse,
        isRealCapture: !!realCapture,
        retakeCount,
        qualityStatus: uiStatus,
        issues,
        qualityScore,
        metrics: qualityMetrics,
        imageQuality: {
          status: uiStatus === 'pass' ? 'good' : (uiStatus === 'borderline' ? 'borderline' : 'poor'),
          qualityScore,
          metrics: qualityMetrics,
          issues,
        }
      });
      setActiveStep(2);
    } catch (err) {
      console.error("Quality Check Error:", err);
      // api-contracts.md: 503 quality_gate_failed means the image WAS saved and
      // can be re-checked later without recalling the patient.
      setStepError({
        title: err.code === 'quality_gate_failed'
          ? 'QUALITY CHECK COULD NOT RUN — THE IMAGE WAS SAVED'
          : 'QUALITY CHECK FAILED — NO RESULT',
        err,
      });
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleRetake = () => {
    setStepError(null);
    setImageFile(null);
    setImagePreviewUrl(null);
    setQualityResult(null);
    setActiveStep(1);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleAcceptQuality = () => setActiveStep(3);

  // Translation into real contract payloads (api-contracts.md & system-design-v4.md §9.1)
  const toRealQuestionnairePayload = (q = {}) => ({
    riskFactors: {
      yearsSinceDiagnosis: ['lt1', '1to5', '5to10', 'gt10'].includes(q?.yearsSinceDiagnosis)
        ? q.yearsSinceDiagnosis
        : (Number(q?.yearsSinceDiagnosis) >= 10 ? 'gt10'
          : Number(q?.yearsSinceDiagnosis) >= 5 ? '5to10'
            : Number(q?.yearsSinceDiagnosis) >= 1 ? '1to5' : 'lt1'),
      glycemicControl: ['good', 'moderate', 'poor'].includes(q?.glycemicControl) ? q.glycemicControl : 'moderate',
      bloodPressure: ['normal', 'high', 'unknown'].includes(q?.bloodPressure) ? q.bloodPressure : 'unknown',
      pregnant: null,
      // ── REAL NUMBERS, ADDITIVE TO THE BUCKETS ABOVE ────────────────────
      yearsDiabetic: Number.isFinite(Number(q?.yearsSinceDiagnosis))
        && String(q?.yearsSinceDiagnosis).trim() !== ''
        ? Number(q.yearsSinceDiagnosis) : null,
      hba1c: Number.isFinite(Number(q?.hba1c)) && String(q?.hba1c).trim() !== ''
        ? Number(q.hba1c) : null,
    },
    symptoms: {
      blurredVision: !!q?.blurredVision,
      floaters: !!q?.floaters,
      suddenVisionChange: !!q?.suddenVisionChange,
      eyePain: !!q?.eyePain,
    },
    language: null,
  });

  const toRealCaptureMetadataPayload = (m = {}) => ({
    cameraDeviceReported: m?.cameraDeviceId || 'unknown',
    pupilStatus: m?.pupilDilation ? 'dilated' : 'non_dilated',
    lightingEnvironment: 'indoor_clinic',
    observedIssues: Array.isArray(m?.issuesNoticed) && m.issuesNoticed.length
      ? m.issuesNoticed.filter((i) =>
        ['glare', 'blink_or_moved', 'out_of_focus', 'media_opacity', 'eyelash_obstruction'].includes(i))
      : ['none_noticed'],
    workerUsabilityRating: 'clear',
  });

  const handleSubmit = async () => {
    setStepError(null);
    setIsSaving(true);
    try {
      if (!USE_MOCK_DATA) {
        // Live: both must be accepted by the local backend before this capture
        // counts as complete. A failure stays on this step with the reason,
        // and SAVE can be pressed again; the capture itself is already stored
        // locally by POST /captures and syncs on its own.
        await localApi.submitQuestionnaire(qualityResult.captureId, toRealQuestionnairePayload(questionnaire));
        await localApi.submitCaptureMetadata(qualityResult.captureId, toRealCaptureMetadataPayload(metadata));
      } else {
        // Mock: the client-side demo queue entry the Local Queue Table and
        // result modal are built around.
        await localApi.saveCaptureMetadata(qualityResult?.captureId || `CAPT-${Date.now()}`, {
          patientId,
          patientName,
          patientAge,
          metadata,
          questionnaire: questionnaire || {},
          aiPrediction: qualityResult?.aiPrediction,
          imagePreviewUrl: imagePreviewUrl || demoFundusImg
        });
      }
      navigate('/queue');
    } catch (err) {
      console.error('Failed to save capture data:', err);
      setStepError({ title: 'QUESTIONNAIRE / CAPTURE DETAILS NOT SAVED', err });
    } finally {
      setIsSaving(false);
    }
  };

  const eyeLabel = metadata.eye === 'left' ? 'LEFT EYE (OS)' : 'RIGHT EYE (OD)';

  return (
    <div className="capture-screen-root">
      {/* ── Title Bar ── */}
      <div className="cs-titlebar">
        <h1 className="t-h1 cs-title">{t('capture.title', 'IMAGE CAPTURE')}</h1>
        <span className="cs-patient-id">
          {t('capture.patient', 'PATIENT:')} <strong style={{ color: 'var(--c-crimson, #CC0000)' }}>{(patientName || '—').toUpperCase()}</strong> ({patientId}) {patientAge ? `• ${patientAge}Y` : ''}
        </span>
      </div>

      {/* ── Stepper ── */}
      <div className="cs-stepper">
        {[
          { n: 1, label: t('capture.steps.capture', '1. CAPTURE') },
          { n: 2, label: t('capture.steps.quality', '2. QUALITY GATE') },
          { n: 3, label: t('capture.steps.metadata', '3. METADATA & SYNC') },
        ].map(({ n, label }) => (
          <div
            key={n}
            className={`cs-step ${activeStep === n ? 'cs-step--active' : ''} ${activeStep > n ? 'cs-step--done' : ''}`}
          >
            {label}{activeStep > n ? ' ✓' : ''}
          </div>
        ))}
      </div>

      {/* ── Main Two-Column Body ── */}
      <div className="cs-body">

        {/* ═══ LEFT: Image Panel ═══ */}
        <div className="cs-image-col">
          {/* Header strip according to active step */}
          {activeStep === 1 && (
            <div className="cs-img-strip">
              <span className="cs-img-strip__label cs-img-strip__label--active">
                {t('capture.liveFeed', 'LIVE FEED')}
              </span>
              <span className="cs-img-strip__label">
                {t('capture.statusCaptured', 'CAPTURED')}
              </span>
            </div>
          )}

          {activeStep === 2 && (
            <div className="cs-img-strip">
              <span className="cs-img-strip__label">
                LIVE FEED
              </span>
              <span className="cs-img-strip__label cs-img-strip__label--active">
                CAPTURED
              </span>
            </div>
          )}

          {activeStep === 3 && (
            <div className="cs-img-strip cs-img-strip--center">
              <span className="cs-img-strip__label cs-img-strip__label--active">
                CAPTURED — {eyeLabel}
              </span>
            </div>
          )}

          <input
            type="file"
            accept="image/png, image/jpeg, image/jpg"
            style={{ display: 'none' }}
            ref={fileInputRef}
            onChange={handleFileChange}
          />

          {/* Image area — fully scaled, object-fit: contain, no cropping, zoomable */}
          <div className={`cs-img-frame ${imageFile ? 'cs-img-frame--has-image' : ''}`} onClick={handleCaptureClick}>
            {imagePreviewUrl ? (
              <RetinalImageViewer src={imagePreviewUrl} alt="Fundus Capture" />
            ) : (
              <div className="cs-img-placeholder">
                <div className="cs-img-placeholder__icon">◎</div>
                <div className="t-mono cs-img-placeholder__text">{t('capture.clickToInitiate', 'CLICK TO INITIATE CAPTURE SEQUENCE')}</div>
                <button
                  type="button"
                  className="btn btn--outline"
                  style={{ fontSize: '0.72rem', padding: '6px 14px', zIndex: 10 }}
                  onClick={handleLoadDemoImage}
                >
                  {t('capture.loadSample', '✦ LOAD SAMPLE RETINAL SCAN')}
                </button>
              </div>
            )}
            {/* Crosshair when empty */}
            {!imageFile && <div className="capture-zone__crosshair" />}
          </div>

          {/* Bottom controls — step 1 only */}
          {imageFile && activeStep === 1 && (
            <div className="cs-bottom-bar">
              <div className="cs-bottom-bar__actions">
                <button className="btn btn--outline cs-retake-btn" onClick={handleRetake} disabled={isAnalyzing}>
                  {t('capture.btnRetake', 'RETAKE')}
                </button>
                <button className="btn cs-run-check-btn" onClick={runQualityCheck} disabled={isAnalyzing}>
                  {isAnalyzing ? t('capture.btnAnalyzing', 'ANALYZING... ✦') : 'RUN QUALITY CHECK →'}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* ═══ RIGHT: Context Panel ═══ */}
        <div className="cs-right-col">
          {stepError && <LoadError error={stepError.err} title={stepError.title} compact />}

          {/* ─── STEP 1: Instructions ─── */}
          {activeStep === 1 && (
            <div className="cs-instructions">
              <h2 className="t-h3 cs-instr-title">
                {t('capture.instructionsTitle', 'INSTRUCTIONS')}
              </h2>
              <div className="cs-instr-divider" />
              <ul className="cs-instr-list">
                {t('capture.instructions', { returnObjects: true }).map((instruction, idx) => (
                  <li key={idx} className="cs-instr-item">
                    <span className="cs-instr-num">0{idx + 1}</span>
                    <span>{instruction}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* ─── STEP 2: Quality Gate (matches reference image 2) ─── */}
          {activeStep === 2 && qualityResult && (
            <div className="cs-quality-panel">
              <QualityResultPanel
                result={qualityResult}
                onRetake={handleRetake}
                onAccept={handleAcceptQuality}
              />
            </div>
          )}

          {/* ─── STEP 3: Metadata & Sync (matches reference image 4) ─── */}
          {activeStep === 3 && (
            <div className="cs-meta-panel">
              <CaptureMetadataForm
                value={metadata}
                onChange={(newMeta) => setMetadata(newMeta)}
              />
              <div className="cs-meta-footer">
                <button className="btn cs-sync-btn" onClick={handleSubmit} disabled={isSaving}>
                  {isSaving ? 'SAVING…' : 'SAVE & SYNC TO SERVER →'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
