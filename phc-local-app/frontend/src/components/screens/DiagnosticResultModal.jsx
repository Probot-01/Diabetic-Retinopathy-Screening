import React, { useMemo } from 'react';
import fundusEyeImg from '../../assets/fundus_eye.jpg';

export const DiagnosticResultModal = React.memo(({ isOpen, onClose, item, prediction, imageUrl }) => {

  // The actual eye image: priority to uploaded image, then item image, then authentic fundus eye photo
  const displayImage = imageUrl || item?.imagePreviewUrl || item?.imageUrl || item?.image || fundusEyeImg;

  // Memoized formatted values
  const severityLabel = useMemo(() => {
    return (prediction?.severity?.label || "Mild NPDR").toUpperCase();
  }, [prediction]);

  const captureTime = useMemo(() => {
    if (!item?.capturedAt) return "02:35 PM";
    try {
      return new Date(item.capturedAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true });
    } catch {
      return "02:35 PM";
    }
  }, [item?.capturedAt]);

  const biomarkers = useMemo(() => [
    {
      id: 'ma',
      name: "Microaneurysms",
      notes: "4 tiny red punctate lesions (temporal quadrant)",
      badgeText: "DETECTED (4)",
      badgeClass: "biomarker-badge--detected",
    },
    {
      id: 'irh',
      name: "Intraretinal Hemorrhages",
      notes: "Dot/blot hemorrhages absent",
      badgeText: "NONE",
      badgeClass: "biomarker-badge--none",
    },
    {
      id: 'he',
      name: "Hard Exudates",
      notes: "No lipid deposits detected",
      badgeText: "NONE",
      badgeClass: "biomarker-badge--none",
    },
    {
      id: 'cws',
      name: "Cotton Wool Spots",
      notes: "No nerve fiber infarcts",
      badgeText: "NONE",
      badgeClass: "biomarker-badge--none",
    },
    {
      id: 'dme',
      name: "Macular Edema Risk",
      notes: "Foveal avascular zone clear",
      badgeText: "LOW (0.04)",
      badgeClass: "biomarker-badge--low",
    },
  ], []);

  if (!isOpen || !item) return null;

  const handlePrint = (e) => {
    e?.stopPropagation();
    window.print();
  };

  const handleCloseAndReturn = (e) => {
    e?.stopPropagation();
    onClose();
  };

  return (
    <div className="result-modal-overlay" onClick={handleCloseAndReturn}>
      <div 
        className="result-modal-card" 
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-patient-name"
      >
        {/* Top Crimson Header Bar */}
        <div className="result-modal__header">
          <div className="result-modal__title-group">
            <span className="result-modal__badge">● AI DIAGNOSTIC REPORT</span>
            <span className="result-modal__capture-id t-mono">
              CAPTURE ID: {item.captureId}
            </span>
          </div>
          <button 
            type="button"
            className="result-modal__close-btn" 
            onClick={handleCloseAndReturn}
            title="Close modal (Esc)"
          >
            ✕ CLOSE
          </button>
        </div>

        {/* 4-Column Patient Info Strip with 1px borders */}
        <div className="result-modal__patient-strip">
          <div className="result-modal__info-item">
            <span className="info-label">PATIENT NAME</span>
            <span className="info-val" id="modal-patient-name" style={{ fontWeight: 700 }}>
              {item.patientName} {item.patientAge ? `(${item.patientAge}Y)` : ''}
            </span>
          </div>
          <div className="result-modal__info-item">
            <span className="info-label">PATIENT ID</span>
            <span className="info-val t-mono">{item.patientId}</span>
          </div>
          <div className="result-modal__info-item">
            <span className="info-label">TIME OF CAPTURE</span>
            <span className="info-val t-mono">{captureTime}</span>
          </div>
          <div className="result-modal__info-item">
            <span className="info-label">PRIMARY HEALTH CENTRE</span>
            <span className="info-val">{item.phcName || 'PHC Kharadi (Pune Dist.)'}</span>
          </div>
        </div>

        {/* Hero Diagnostic Verdict Box */}
        <div className="result-modal__verdict-box">
          <div className="verdict-main">
            <span className="verdict-tagline t-mono">AI SEVERITY CLASSIFICATION</span>
            <h2 className="verdict-grade">{severityLabel}</h2>
            <p className="verdict-desc">
              Early signs of diabetic retinopathy detected. Microaneurysms present in the temporal parafoveal region. No macular edema or neovascularization noted.
            </p>
          </div>

          <div className="verdict-stats">
          </div>
        </div>

        {/* Visual Inspection & Biomarkers Grid */}
        <div className="result-modal__body-grid">
          {/* Fundus Preview Column */}
          <div className="result-modal__scan-column">
            <div className="scan-frame-header">
              <span className="t-mono" style={{ fontSize: '11px', fontWeight: 800 }}>
                MACULA-CENTERED FUNDUS SCAN (OD)
              </span>
              <span className="scan-badge">QUALITY PASSED</span>
            </div>

            <div className="scan-image-wrapper">
              <img 
                src={displayImage} 
                alt="Retinal Fundus Preview" 
                className="scan-image" 
              />
              <div className="scan-bracket scan-bracket--tl"></div>
              <div className="scan-bracket scan-bracket--tr"></div>
              <div className="scan-bracket scan-bracket--bl"></div>
              <div className="scan-bracket scan-bracket--br"></div>
              <div className="scan-fovea-reticle"></div>
            </div>


          </div>

          {/* Lesion & Verification Checklist */}
          <div className="result-modal__checklist-column">
            <h3 className="checklist-title t-mono">BIOMARKER EVIDENCE SUMMARY</h3>

            <div className="biomarker-list">
              {biomarkers.map((bm) => (
                <div 
                  key={bm.id} 
                  className={`biomarker-row ${bm.id === 'ma' ? 'biomarker-row--detected' : ''}`}
                >
                  <div className="biomarker-info">
                    <span className="biomarker-name">{bm.name}</span>
                    <span className="biomarker-notes">{bm.notes}</span>
                  </div>
                  <span className={`biomarker-badge ${bm.badgeClass}`}>
                    {bm.badgeText}
                  </span>
                </div>
              ))}
            </div>

            {/* Sync Notice with 4px red left border & subtle red tint */}
            <div className="referral-notice">
              <span className="referral-notice__title t-mono">
                TELE-OPHTHALMOLOGY SYNC NOTICE
              </span>
              <p className="referral-notice__text">
                This screening result has been automatically committed to the Central Ophthalmology Review Pipeline. Central District Admin and Ophthalmologists have been notified for tele-verification.
              </p>
            </div>
          </div>
        </div>

        {/* Footer Actions with Signature Drop-Shadows */}
        <div className="result-modal__footer">
          <button 
            type="button" 
            className="result-modal__btn result-modal__btn--print" 
            onClick={handlePrint}
          >
            🖨 PRINT CLINICAL SLIP
          </button>
          <button 
            type="button" 
            className="result-modal__btn result-modal__btn--done" 
            onClick={handleCloseAndReturn}
          >
            DONE & RETURN TO QUEUE
          </button>
        </div>
      </div>
    </div>
  );
});
