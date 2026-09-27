import React, { useState, useEffect, useCallback } from 'react';
import { localApi } from '../../api/localApiClient';
import { USE_MOCK_DATA } from '../../config';
import { LoadError } from '../shared/LoadError';

/**
 * PairedDevicesPage -- the phones paired with this PHC PC, and how to cut one off.
 *
 * The backend has had GET /peer/devices and POST /peer/devices/:id/revoke since
 * the peer-sync protocol landed, and no screen called either. A phone pairs by
 * QR from the PC, and a pairing key reads every patient record on this machine
 * -- so until now a lost or stolen phone stayed paired indefinitely, because
 * the only way to revoke it was an HTTP call nobody in a clinic can make.
 *
 * Deliberate choices:
 *
 *   - A REVOKED DEVICE STAYS LISTED, greyed, with the date. The record that a
 *     phone once had access is the thing an incident review needs; making it
 *     vanish would be tidier and less honest.
 *   - REVOKE IS CONFIRMED IN TWO STEPS, because it cannot be undone from here:
 *     re-admitting that phone means pairing it again, with a new key.
 *   - THE BUTTON IS HIDDEN FOR A NON-ADMIN, and that is a convenience only.
 *     requireTechnician.admin on the backend is the actual control, and a 403
 *     from it is shown as a 403 rather than swallowed.
 *   - MOCK MODE REFUSES TO REVOKE. A demo that reported success without a
 *     backend would teach an operator that a phone is cut off when it is not.
 */

const fmt = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  // IST, like every other date in these apps.
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
};

/** "3 days ago" for last-seen, where staleness is the thing worth noticing. */
const sinceText = (iso) => {
  if (!iso) return 'never connected';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'never connected';
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return 'seen today';
  if (days === 1) return 'seen yesterday';
  return `seen ${days} days ago`;
};

export const PairedDevicesPage = ({ auth }) => {
  const [devices, setDevices] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [confirmId, setConfirmId] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [actionError, setActionError] = useState(null);

  // 'phc_admin' is the backend's own value (scripts/technician.js); the other
  // is 'technician'. The session carries whichever the server issued.
  const isAdmin = auth?.role === 'phc_admin';

  // reloadKey rather than calling load() straight from the effect: the same
  // cancelled-flag pattern the queue screen uses, so a response that lands
  // after the screen is gone cannot set state on an unmounted component.
  const [reloadKey, setReloadKey] = useState(0);
  const load = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const data = await localApi.getPeerDevices();
        if (cancelled) return;
        setDevices(data);
      } catch (err) {
        if (cancelled) return;
        // A failure is shown as a failure: no empty table standing in for
        // "nothing is paired", which would be the dangerous reading.
        setDevices(null);
        setLoadError(err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [reloadKey]);

  const revoke = async (deviceId) => {
    setBusyId(deviceId);
    setActionError(null);
    try {
      await localApi.revokePeerDevice(deviceId);
      setConfirmId(null);
      load();                // re-read rather than patch state: the server decides
    } catch (err) {
      setActionError(err);
    } finally {
      setBusyId(null);
    }
  };

  const active = (devices || []).filter((d) => !d.revokedAt);

  return (
    <div className="section">
      <div className="u-flex u-justify-between u-items-center u-mb-3">
        <h1 className="t-h1">PAIRED DEVICES</h1>
        <div className="t-mono" style={{ opacity: 0.6, fontSize: '0.85rem' }}>
          {devices ? `${active.length} ACTIVE / ${devices.length} TOTAL` : '—'}
        </div>
      </div>

      <p className="t-mono" style={{ fontSize: '12px', opacity: 0.7, marginBottom: 'var(--sp-4, 16px)', maxWidth: '70ch' }}>
        Phones and tablets that can replicate patient records with this PC over the
        clinic network. A paired device holds a key that reads every record on this
        machine. Revoke one as soon as it is lost, replaced, or leaves the clinic.
        {!isAdmin && ' Revoking requires a PHC admin account.'}
      </p>

      {actionError && (
        <LoadError error={actionError} title="COULD NOT REVOKE THAT DEVICE"
          onRetry={() => setActionError(null)} />
      )}

      {loadError ? (
        <LoadError error={loadError} what="the paired devices" onRetry={load} />
      ) : (
        <div className="panel">
          <div className="queue-table-wrapper">
            <table className="table">
              <thead>
                <tr>
                  <th>DEVICE</th>
                  <th>PAIRED</th>
                  <th>LAST SEEN</th>
                  <th>STATUS</th>
                  <th>ACTION</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr><td colSpan="5" className="u-p-6">
                    <div className="skeleton" style={{ height: '28px', width: '100%' }} />
                  </td></tr>
                )}

                {!loading && devices && devices.length === 0 && (
                  <tr><td colSpan="5" className="u-text-center u-p-6">
                    <span className="t-mono" style={{ opacity: 0.6 }}>
                      NO DEVICE HAS EVER BEEN PAIRED WITH THIS PC.
                    </span>
                  </td></tr>
                )}

                {!loading && (devices || []).map((d) => {
                  const revoked = !!d.revokedAt;
                  return (
                    <tr key={d.deviceId} style={revoked ? { opacity: 0.45 } : undefined}>
                      <td>
                        <span className="t-mono" style={{ fontWeight: 600 }}>{d.name || 'Unnamed device'}</span>
                        <div className="t-mono" style={{ fontSize: '11px', opacity: 0.5 }}>{d.deviceId}</div>
                      </td>
                      <td><span className="t-mono" style={{ fontSize: '12px' }}>{fmt(d.createdAt) || '—'}</span></td>
                      <td>
                        <span className="t-mono" style={{ fontSize: '12px' }}>{fmt(d.lastSeenAt) || 'never'}</span>
                        <div className="t-mono" style={{ fontSize: '11px', opacity: 0.5 }}>{sinceText(d.lastSeenAt)}</div>
                      </td>
                      <td>
                        {revoked ? (
                          <span className="t-mono" style={{ fontSize: '12px', fontWeight: 700 }}>
                            REVOKED
                            <div style={{ fontSize: '11px', opacity: 0.7, fontWeight: 400 }}>{fmt(d.revokedAt)}</div>
                          </span>
                        ) : (
                          <span className="t-mono" style={{ fontSize: '12px', fontWeight: 700, color: 'var(--c-success, #2e7d32)' }}>
                            ACTIVE
                          </span>
                        )}
                      </td>
                      <td>
                        {revoked ? (
                          <span className="t-mono" style={{ fontSize: '11px', opacity: 0.6 }}>—</span>
                        ) : !isAdmin ? (
                          <span className="t-mono" style={{ fontSize: '11px', opacity: 0.6 }}
                            title="Revoking a paired device requires a PHC admin account.">
                            ADMIN ONLY
                          </span>
                        ) : confirmId === d.deviceId ? (
                          <span className="u-flex u-items-center" style={{ gap: '8px' }}>
                            {/* Destructive, so it does not wear the same colour
                                as the safe action next to it. */}
                            <button type="button" className="btn btn--danger"
                              style={{ padding: '2px 10px', fontSize: '11px' }}
                              disabled={busyId === d.deviceId}
                              onClick={() => revoke(d.deviceId)}>
                              {busyId === d.deviceId ? 'REVOKING…' : 'CONFIRM REVOKE'}
                            </button>
                            <button type="button" className="btn btn--outline"
                              style={{ padding: '2px 8px', fontSize: '11px' }}
                              disabled={busyId === d.deviceId}
                              onClick={() => setConfirmId(null)}>
                              CANCEL
                            </button>
                          </span>
                        ) : (
                          <button type="button" className="btn-action-col btn-action-col--active"
                            onClick={() => { setActionError(null); setConfirmId(d.deviceId); }}
                            title="Cut this device off from this PC. It cannot be undone from here.">
                            REVOKE
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {confirmId && (
        <p className="t-mono" style={{ fontSize: '12px', marginTop: 'var(--sp-3, 12px)', color: 'var(--c-crimson, #C42B2B)', fontWeight: 700 }}>
          Revoking cannot be undone from here. Re-admitting that device means pairing it
          again from this PC, which issues it a new key.
        </p>
      )}

      {USE_MOCK_DATA && (
        <p className="t-mono" style={{ fontSize: '11px', opacity: 0.7, marginTop: 'var(--sp-3, 12px)' }}>
          Demo data. Revoking is refused here: it can only really be done against the
          live PHC backend, and reporting success without one would be a lie about
          who can read patient records.
        </p>
      )}
    </div>
  );
};
