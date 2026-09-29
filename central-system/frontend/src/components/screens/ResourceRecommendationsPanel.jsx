import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { centralApi } from '../../api/centralApiClient';
import { LoadError } from '../shared/LoadError';

// One decimal for display; the model returns full floats. null stays null.
const round1 = (v) => (typeof v === "number" ? Math.round(v * 10) / 10 : v);

export const ResourceRecommendationsPanel = () => {
  const { t } = useTranslation();
  const [recommendations, setRecommendations] = useState(null);
  const [validation, setValidation] = useState(null);
  const [loading, setLoading] = useState(true);
  const [simulating, setSimulating] = useState(false);
  const [validating, setValidating] = useState(false);
  const [toast, setToast] = useState(null);
  // Independent sources, independent failures. 404 before a model's first run
  // is an expected state (api-contracts.md), not a broken server.
  const [recError, setRecError] = useState(null);
  const [valError, setValError] = useState(null);

  useEffect(() => {
    let active = true;
    Promise.allSettled([
      centralApi.getResourceRecommendations(),
      centralApi.getSimulinkValidation(),
    ]).then(([rec, val]) => {
      if (!active) return;
      if (rec.status === 'fulfilled') setRecommendations(rec.value); else setRecError(rec.reason);
      if (val.status === 'fulfilled') setValidation(val.value); else setValError(val.reason);
      setLoading(false);
    });
    return () => { active = false; };
  }, []);

  const handleRunSimulation = async () => {
    setSimulating(true);
    try {
      const updated = await centralApi.refreshResourceRecommendations();
      setRecommendations(updated);
      setRecError(null);
      setToast({ type: 'success', message: `Resource model run completed${updated?.runSeconds != null ? ` (${updated.runSeconds}s run time)` : ''}.` });
    } catch (err) {
      setToast({ type: 'error', message: `Simulation run failed: ${err.message}` });
    } finally {
      setSimulating(false);
      setTimeout(() => setToast(null), 4000);
    }
  };

  const handleRunValidation = async () => {
    setValidating(true);
    try {
      const updated = await centralApi.refreshSimulinkValidation();
      setValidation(updated);
      setValError(null);
      setToast({ type: 'success', message: `SimEvents .slx co-validation finished with status: ${String(updated?.status ?? 'unknown').toUpperCase()}.` });
    } catch (err) {
      setToast({ type: 'error', message: `Simulink validation failed: ${err.message}` });
    } finally {
      setValidating(false);
      setTimeout(() => setToast(null), 4000);
    }
  };

  if (!loading && !recommendations) {
    const notRunYet = recError?.code === 'recommendations_not_generated';
    return (
      <div className="section">
        {toast && <p className="t-mono u-mb-4" style={{ color: toast.type === 'error' ? 'var(--c-crimson)' : 'var(--c-success)' }}>{toast.message}</p>}
        <div className="u-flex u-items-center u-justify-between u-mb-6">
          <div>
            <p className="section__subtitle">{t('central.resources.subtitle', 'DISTRICT RESOURCE PLANNING & MODELLING')}</p>
            <h1 className="section__title" style={{ marginBottom: 0 }}>{t('central.resources.title', 'RESOURCE ALLOCATION')}</h1>
          </div>
          <button className="btn btn--primary" onClick={handleRunSimulation} disabled={simulating}>
            {simulating ? 'RUNNING THE MODEL…' : '⚡ RUN THE RESOURCE MODEL NOW'}
          </button>
        </div>
        {notRunYet
          ? (
            <div role="status">
              <p className="t-mono" style={{ fontWeight: 700 }}>Simulation results not yet generated.</p>
              <p className="t-mono">The district resource model has not run on this server yet. It runs daily, or now with the button above. No figures are shown until it has.</p>
            </div>
          )
          : <LoadError error={recError} what="resource recommendations" />}
        {valError && valError.code !== 'validation_not_run' && <LoadError error={valError} what="the Simulink validation" />}
      </div>
    );
  }

  if (loading) {
    return (
      <div className="section">
        <div className="skeleton" style={{ height: '40px', width: '320px', marginBottom: 'var(--sp-6)' }} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--sp-4)' }}>
          {[...Array(4)].map((_, i) => <div key={i} className="skeleton" style={{ height: '140px' }} />)}
        </div>
        <div className="skeleton" style={{ height: '260px', marginTop: 'var(--sp-6)' }} />
      </div>
    );
  }

  const { current, params, inputsSource, bottleneck, recommendation } = recommendations;
  const isOverTarget = current.reviewWaitP95Min > recommendations.p95TargetMin;

  return (
    <div className="section">
      {/* Toast Notification */}
      {toast && (
        <div
          style={{
            position: 'fixed',
            bottom: '24px',
            right: '24px',
            background: toast.type === 'error' ? '#A82222' : '#14B8A6',
            color: '#FFFFFF',
            padding: '12px 20px',
            fontFamily: 'var(--f-mono)',
            fontSize: '12px',
            fontWeight: 700,
            boxShadow: '4px 4px 0px rgba(0,0,0,0.8)',
            zIndex: 9999,
          }}
        >
          {toast.message}
        </div>
      )}

      {/* Header */}
      <div className="u-flex u-items-center u-justify-between u-mb-6">
        <div>
          <p className="section__subtitle">{t('central.resources.subtitle', 'DISTRICT RESOURCE PLANNING & MODELLING')}</p>
          <h1 className="section__title" style={{ marginBottom: 0 }}>
            {t('central.resources.title', 'RESOURCE ALLOCATION')}
          </h1>
        </div>
        <div className="u-flex u-items-center" style={{ gap: '12px' }}>
          <span className="t-mono" style={{ fontSize: '11px', opacity: 0.7 }}>
            Model: {recommendations.model}
          </span>
          <button
            className="btn btn--primary"
            onClick={handleRunSimulation}
            disabled={simulating}
            style={{
              padding: '8px 16px',
              fontSize: '11px',
              fontFamily: 'var(--f-mono)',
              boxShadow: '3px 3px 0px var(--c-crimson)',
            }}
          >
            {simulating ? 'SIMULATING (2s)...' : '⚡ RUN ON-DEMAND SIMULATION'}
          </button>
        </div>
      </div>

      {/* Primary Bottleneck & Action Banner */}
      <div
        style={{
          border: '2px solid var(--c-crimson)',
          background: isOverTarget ? 'rgba(168, 34, 34, 0.08)' : 'rgba(20, 184, 166, 0.08)',
          padding: '20px',
          marginBottom: 'var(--sp-6)',
          boxShadow: '4px 4px 0px var(--c-crimson)',
        }}
      >
        <div className="u-flex u-items-center u-justify-between u-mb-2">
          <div className="u-flex u-items-center" style={{ gap: '10px' }}>
            <span
              className={`badge ${isOverTarget ? 'badge--fail' : 'badge--pass'}`}
              style={{ padding: '4px 10px', fontSize: '11px' }}
            >
              BOTTLENECK: {bottleneck.toUpperCase()}
            </span>
            <span className="t-mono" style={{ fontSize: '11px', color: 'var(--c-text-muted)' }}>
              Last computed: {new Date(recommendations.generatedAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })}
            </span>
          </div>
          <span className="t-mono" style={{ fontSize: '11px', fontWeight: 700 }}>
            Target: P95 Wait &lt; {recommendations.p95TargetMin}m
          </span>
        </div>
        <div style={{ fontFamily: 'var(--f-display)', fontSize: '1.25rem', fontWeight: 900, color: 'var(--c-text)', marginTop: '6px' }}>
          {recommendation}
        </div>
      </div>

      {/* Staffing KPI Bento Grid */}
      <div className="bento u-mb-6">
        <div className="bento--span-3">
          <div className="stat hash-fill">
            <div className="stat__label">ROUTINE STAFFING REQ.</div>
            <div className="stat__value" style={{ color: 'var(--c-crimson)' }}>
              {recommendations.minOphthalmologistsRoutine} <span style={{ fontSize: '14px', color: 'var(--c-text-muted)' }}>Doctors</span>
            </div>
            <div className="stat__delta" style={{ color: 'var(--c-warning)' }}>
              Current pool: {current.numOphthalmologists}
              {recommendations.minOphthalmologistsRoutine != null && current.numOphthalmologists != null
                && recommendations.minOphthalmologistsRoutine > current.numOphthalmologists
                ? ` (Shortage: +${recommendations.minOphthalmologistsRoutine - current.numOphthalmologists})` : ''}
            </div>
          </div>
        </div>

        <div className="bento--span-3">
          <div className="stat hash-fill">
            <div className="stat__label">CAMP / BATCH SURGE REQ.</div>
            <div className="stat__value" style={{ color: '#F97316' }}>
              {recommendations.minOphthalmologistsCamp} <span style={{ fontSize: '14px', color: 'var(--c-text-muted)' }}>Doctors</span>
            </div>
            <div className="stat__delta" style={{ color: 'var(--c-text-muted)' }}>
              Annual volume in 50 camp days ({params.campMultiplier}x surge)
            </div>
          </div>
        </div>

        <div className="bento--span-3">
          <div className="stat hash-fill">
            <div className="stat__label">CURRENT REVIEW WAIT (P95)</div>
            <div className="stat__value" style={{ color: isOverTarget ? '#A82222' : '#14B8A6' }}>
              {round1(current.reviewWaitP95Min)} <span style={{ fontSize: '14px' }}>min</span>
            </div>
            <div className="stat__delta" style={{ color: isOverTarget ? '#A82222' : 'var(--c-success)' }}>
              {isOverTarget ? `+${round1(current.reviewWaitP95Min - recommendations.p95TargetMin)}m over SLA target` : 'Within SLA target'}
            </div>
          </div>
        </div>

        <div className="bento--span-3">
          <div className="stat hash-fill">
            <div className="stat__label">REVIEW POOL UTILIZATION</div>
            <div className="stat__value">
              {round1(current.reviewUtilisationPct)}%
            </div>
            <div className="stat__delta" style={{ color: current.reviewUtilisationPct > 70 ? 'var(--c-warning)' : 'var(--c-success)' }}>
              Upload bandwidth: {round1(current.uploadUtilisationPct)}% ({round1(current.uploadWaitP95Min)}m wait)
            </div>
          </div>
        </div>
      </div>

      {/* Input Sources & Model Assumptions */}
      <div style={{ border: 'var(--border)', padding: 'var(--sp-6)', marginBottom: 'var(--sp-6)', background: 'rgba(0,0,0,0.01)' }}>
        <h3 className="t-h3 u-mb-3" style={{ fontSize: '14px', letterSpacing: '0.05em' }}>
          MODELLED ASSUMPTIONS VS. OBSERVED FIELD DATA
        </h3>
        <p style={{ fontSize: '12px', color: 'var(--c-text-muted)', marginBottom: '16px' }}>
          Planning recommendations are computed by the calibrated queueing model. Below are the specific empirical vs modeled inputs feeding this run:
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px' }}>
          <div style={{ borderLeft: '3px solid #14B8A6', paddingLeft: '12px' }}>
            <div className="t-mono" style={{ fontSize: '11px', fontWeight: 700, color: 'var(--c-text)' }}>TIER FRACTIONS</div>
            <div className="t-mono" style={{ fontSize: '11px', color: 'var(--c-text-muted)', marginTop: '4px' }}>
              {inputsSource.tierFractions}
            </div>
          </div>
          <div style={{ borderLeft: '3px solid #14B8A6', paddingLeft: '12px' }}>
            <div className="t-mono" style={{ fontSize: '11px', fontWeight: 700, color: 'var(--c-text)' }}>REVIEW SERVICE TIME</div>
            <div className="t-mono" style={{ fontSize: '11px', color: 'var(--c-text-muted)', marginTop: '4px' }}>
              {/* The backend has never computed a per-source label for this one
                  specifically -- resourceRecommendations.js's gatherInputs()
                  only ever sets a single combined `source.other` disclaimer
                  covering review time, bandwidth tiers and image size together.
                  Fall back to that rather than render this cell blank. */}
              {inputsSource.reviewServiceTime || inputsSource.other}
            </div>
          </div>
          <div style={{ borderLeft: '3px solid #F97316', paddingLeft: '12px' }}>
            <div className="t-mono" style={{ fontSize: '11px', fontWeight: 700, color: 'var(--c-text)' }}>ARRIVAL PATTERNS</div>
            <div className="t-mono" style={{ fontSize: '11px', color: 'var(--c-text-muted)', marginTop: '4px' }}>
              {inputsSource.arrivalPattern || inputsSource.other}
            </div>
          </div>
        </div>
      </div>

      {valError && (valError.code === 'validation_not_run'
        ? <p className="t-mono u-mb-4">Simulation results not yet generated. The Simulink co-validation runs weekly, or on demand with the button below.</p>
        : <LoadError error={valError} what="the Simulink validation" />)}

      {/* Simulink Model Validation Card (PS-Requirement 5 Co-Validation) */}
      {validation && (
        <div style={{ border: 'var(--border)', padding: 'var(--sp-6)' }}>
          <div className="u-flex u-items-center u-justify-between u-mb-4">
            <div>
              <div className="u-flex u-items-center" style={{ gap: '10px' }}>
                <h3 className="t-h3" style={{ fontSize: '14px', margin: 0 }}>
                  SIMULINK SIMEVENTS (.SLX) CO-VALIDATION
                </h3>
                <span
                  className={`badge ${
                    validation.status === 'agree' ? 'badge--pass' : validation.status === 'diverged' ? 'badge--fail' : 'badge--neutral'
                  }`}
                  style={{ padding: '3px 8px', fontSize: '10px' }}
                >
                  STATUS: {validation.status.toUpperCase()}
                </span>
              </div>
              <p style={{ fontSize: '11px', color: 'var(--c-text-muted)', margin: '4px 0 0 0' }}>
                PS Requirement 5 deliverable validation. Verified referenceQueueingModel.m against SimEvents discrete-event simulation.
              </p>
            </div>
            <button
              className="btn btn--secondary"
              onClick={handleRunValidation}
              disabled={validating}
              style={{
                padding: '6px 14px',
                fontSize: '10px',
                fontFamily: 'var(--f-mono)',
              }}
            >
              {validating ? 'RUNNING .SLX (49s)...' : 'RE-RUN SIMULINK VALIDATION'}
            </button>
          </div>

          <div className="table-wrapper u-mb-4">
            <table className="table">
              <thead>
                <tr>
                  <th>METRIC</th>
                  <th className="u-text-right">SIMEVENTS (.SLX)</th>
                  <th className="u-text-right">REFERENCE MODEL</th>
                  <th className="u-text-right">TOLERANCE</th>
                  <th>VERDICT</th>
                </tr>
              </thead>
              <tbody>
                {validation.checks.map((chk, idx) => (
                  <tr key={idx}>
                    <td className="t-mono" style={{ fontWeight: 700 }}>{chk.metric}</td>
                    <td className="t-mono u-text-right">{round1(chk.simEvents)}{chk.unit}</td>
                    <td className="t-mono u-text-right">{round1(chk.reference)}{chk.unit}</td>
                    <td className="t-mono u-text-right">±{round1(chk.tolerance)}{chk.unit}</td>
                    <td>
                      <span className={`badge ${chk.agree ? 'badge--pass' : 'badge--fail'}`}>
                        {chk.agree ? 'AGREE' : 'DIVERGED'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div
            style={{
              padding: '10px 14px',
              background: 'rgba(0,0,0,0.04)',
              borderLeft: '3px solid var(--c-crimson)',
              fontFamily: 'var(--f-mono)',
              fontSize: '11px',
              color: 'var(--c-text)',
            }}
          >
            <strong>Note (Design Doc §16 / API Contract):</strong> {validation.note} Upload figures are not compared between models by construction due to differing queue models.
          </div>
        </div>
      )}
    </div>
  );
};
