import React from 'react';
import { USE_MOCK_DATA } from '../../config';
import {
  PUPIL_STATUS, LIGHTING_ENVIRONMENT, OBSERVED_ISSUES, USABILITY_RATING, NONE_NOTICED,
} from '../../api/captureOptions';

/**
 * The capture-context questionnaire (design doc §9.6): about the PHOTO, not the
 * patient. Tap-only. Every question uses the API's own values, and in live mode
 * NOTHING is pre-answered -- an answer the technician did not give is not an
 * answer (it used to default to "indoor clinic", "clear" and "non-dilated", and
 * to throw away any observed issue that was not in the API's list).
 *
 * Which EYE and which CAMERA were chosen before the photograph was taken
 * (CaptureScreen step 1), so they are not asked again here.
 */

/** A blank form. Mock mode starts filled in, for the demo. */
export const initialMetadata = () => (USE_MOCK_DATA
  ? { pupilStatus: 'dilated', lightingEnvironment: 'indoor_clinic', workerUsabilityRating: 'clear', observedIssues: [NONE_NOTICED] }
  : { pupilStatus: null, lightingEnvironment: null, workerUsabilityRating: null, observedIssues: [] });

const Choice = ({ label, options, value, onChange }) => (
  <div className="meta-field">
    <label className="meta-label">{label} <span style={{ color: 'var(--c-crimson, #C42B2B)' }}>*</span></label>
    <div className="meta-chip-grid">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          className={`meta-chip ${value === o.id ? 'meta-chip--active' : ''}`}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  </div>
);

export const CaptureMetadataForm = ({ value, onChange }) => {
  const set = (field, v) => onChange({ ...value, [field]: v });

  const issues = value.observedIssues || [];
  const toggleIssue = (id) => {
    if (id === NONE_NOTICED) {
      // "None noticed" stands alone (api-contracts.md).
      set('observedIssues', issues.includes(NONE_NOTICED) ? [] : [NONE_NOTICED]);
      return;
    }
    const without = issues.filter((i) => i !== NONE_NOTICED);
    set('observedIssues', without.includes(id) ? without.filter((i) => i !== id) : [...without, id]);
  };

  return (
    <div className="meta-card">
      <div className="meta-card__header">
        <h3 className="meta-card__title">CAPTURE DETAILS</h3>
      </div>

      <div className="meta-card__body">
        <Choice label="PUPIL STATUS" options={PUPIL_STATUS} value={value.pupilStatus}
          onChange={(v) => set('pupilStatus', v)} />

        <Choice label="LIGHTING" options={LIGHTING_ENVIRONMENT} value={value.lightingEnvironment}
          onChange={(v) => set('lightingEnvironment', v)} />

        <div className="meta-field">
          <label className="meta-label">
            ISSUES YOU NOTICED WHILE CAPTURING <span style={{ color: 'var(--c-crimson, #C42B2B)' }}>*</span>
          </label>
          <div className="meta-chip-grid">
            {[...OBSERVED_ISSUES, { id: NONE_NOTICED, label: 'NONE NOTICED' }].map((o) => (
              <button
                key={o.id}
                type="button"
                className={`meta-chip ${issues.includes(o.id) ? 'meta-chip--active' : ''}`}
                onClick={() => toggleIssue(o.id)}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        <Choice label="HOW USABLE DOES THE IMAGE LOOK TO YOU?" options={USABILITY_RATING}
          value={value.workerUsabilityRating} onChange={(v) => set('workerUsabilityRating', v)} />
      </div>
    </div>
  );
};
