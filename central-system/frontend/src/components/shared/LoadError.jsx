import React from 'react';

/**
 * LoadError — the live-mode error state. Shown in place of a screen's data
 * when its request failed, so a failure is visible as a failure and is never
 * papered over with fixture data (design doc §1.22).
 *
 *   <LoadError error={err} what="the review queue" onRetry={reload} />
 *
 * `error` is normally an ApiError from centralApiClient ({ code, message }).
 */
export const LoadError = ({ error, what = 'this data', onRetry, compact = false }) => (
  <div
    role="alert"
    className={compact ? '' : 'u-mb-6'}
    style={{
      border: '2px solid var(--c-crimson, #C42B2B)',
      background: 'var(--c-cream-light, #FAF6EF)',
      padding: compact ? 'var(--sp-3, 12px)' : 'var(--sp-5, 20px)',
      fontFamily: 'var(--font-mono, monospace)',
    }}
  >
    <div style={{ color: 'var(--c-crimson, #C42B2B)', fontWeight: 700, letterSpacing: '1px', fontSize: 13 }}>
      COULD NOT LOAD {String(what).toUpperCase()}
    </div>
    <p style={{ margin: '8px 0 0', color: 'var(--c-text, #2C1810)', fontSize: 13, lineHeight: 1.5 }}>
      {error?.message || 'The request failed.'}
    </p>
    {error?.code && (
      <p style={{ margin: '4px 0 0', color: 'var(--c-text-muted, #6b5a50)', fontSize: 11 }}>
        code: {error.code}{error.status ? ` · HTTP ${error.status}` : ''}
      </p>
    )}
    {onRetry && (
      <button type="button" className="btn btn--secondary" onClick={onRetry} style={{ marginTop: 12 }}>
        RETRY
      </button>
    )}
  </div>
);
