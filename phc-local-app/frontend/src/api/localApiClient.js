import { USE_MOCK_DATA, LOCAL_API_BASE } from '../config';
import * as mockData from './mockData';

// Delay helper to simulate network latency (mock mode only)
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// How long a real call to the local backend may take before it is reported as
// failed. The quality gate itself can take a few seconds (it runs a real image
// analysis), so this is generous.
const REAL_CALL_TIMEOUT_MS = 8000;
// POST /captures runs the MATLAB quality gate synchronously; a cold MATLAB
// start is far slower than any other call here.
const CAPTURE_TIMEOUT_MS = 60000;

/**
 * ApiError — what every live-mode failure rejects with. `code` is the
 * contract's snake_case `error` field (api-contracts.md, "Error shape") or a
 * client-side code (network_error, timeout, config_missing, bad_response).
 */
export class ApiError extends Error {
  constructor(code, message, status = null) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

/**
 * The technician's session token from POST /auth/login (App.jsx keeps the
 * login payload in localStorage 'netra_phc_auth'). Sent as a Bearer header on
 * every real call; required once the local backend runs with
 * LOCAL_AUTH_ENABLED=true.
 */
function authHeader() {
  try {
    const token = JSON.parse(localStorage.getItem('netra_phc_auth') || 'null')?.token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

/**
 * DATA MODE (config.js): mock mode serves fixtures from mockData.js and nothing
 * else; live mode serves the PHC local backend and nothing else. A live request
 * that fails REJECTS — no fixture patients, no invented quality result, no
 * silent "best effort" (design doc §1.22). Callers render the rejection.
 */
class LocalApiClient {
  constructor() {
    this.useMock = USE_MOCK_DATA;
    this.baseUrl = LOCAL_API_BASE;
  }

  /** fetch + timeout + auth + contract error shape -> parsed JSON, or ApiError. */
  async _request(path, options = {}, timeoutMs = REAL_CALL_TIMEOUT_MS) {
    if (!this.baseUrl) {
      throw new ApiError('config_missing',
        'VITE_LOCAL_API_BASE is not set, so this app does not know where the PHC backend is. ' +
        'Set it in phc-local-app/frontend/.env and restart the dev server.');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        ...options,
        headers: { ...authHeader(), ...(options.headers || {}) },
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new ApiError('timeout', `The PHC backend did not answer within ${Math.round(timeoutMs / 1000)} s (${path}).`);
      }
      throw new ApiError('network_error', `Cannot reach the PHC backend at ${this.baseUrl}. Is it running?`);
    } finally {
      clearTimeout(timer);
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      throw new ApiError(body?.error || `http_${res.status}`,
        body?.message || `${res.status} ${res.statusText} from ${path}`, res.status);
    }
    return body;
  }

  /** POST /auth/login -> { token, expiresAt, user }. Throws with the backend's message. */
  async login(username, password) {
    return this._request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
  }

  async getPatients() {
    if (this.useMock) {
      await delay(500);
      return [...mockData.mockPatients];
    }
    const data = await this._request('/patients');
    if (!Array.isArray(data)) throw new ApiError('bad_response', 'The patient list response was not a list.');
    return data;
  }

  /** registerPatient(patientData) -> POST /patients. Live: rejects on any failure. */
  async registerPatient(patientData) {
    if (this.useMock) {
      await delay(400);
      const newPatient = {
        patientId: `PHC001-${Math.random().toString(36).substring(2, 8).toUpperCase()}-NEW1`,
        registeredAt: new Date().toISOString(),
        ...patientData
      };
      mockData.mockPatients.unshift(newPatient);
      try {
        localStorage.setItem('netra_latest_patient', JSON.stringify(newPatient));
        const existing = JSON.parse(localStorage.getItem('netra_registered_patients') || '[]');
        localStorage.setItem('netra_registered_patients', JSON.stringify([newPatient, ...existing]));
      } catch (e) {}
      return newPatient;
    }
    const data = await this._request('/patients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patientData)
    });
    if (!data || typeof data.patientId !== 'string') {
      throw new ApiError('bad_response', 'The registration response had no patientId; the patient may not have been saved.');
    }
    return data;
  }

  /**
   * submitCapture(patientId, imageFile, cameraDeviceId) -> POST /captures, which
   * saves the image and runs the local quality gate. Mock mode returns null
   * (CaptureScreen then uses its scenario fixtures). Live mode rejects on
   * failure — including 503 quality_gate_failed, where the image WAS saved.
   */
  async submitCapture(patientId, imageFile, cameraDeviceId = 'unknown') {
    if (this.useMock) return null;
    const formData = new FormData();
    formData.append('patientId', patientId);
    formData.append('cameraDeviceId', cameraDeviceId);
    formData.append('image', imageFile);
    const data = await this._request('/captures', { method: 'POST', body: formData }, CAPTURE_TIMEOUT_MS);
    if (!data || typeof data.captureId !== 'string' || typeof data.qualityStatus !== 'string') {
      throw new ApiError('bad_response', 'The capture response did not have the expected shape.');
    }
    return data;
  }

  /** POST /captures/:captureId/questionnaire. Live: rejects on failure. */
  async submitQuestionnaire(captureId, payload) {
    if (this.useMock) return null;
    return this._request(`/captures/${encodeURIComponent(captureId)}/questionnaire`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  /** POST /captures/:captureId/capture-metadata. Live: rejects on failure. */
  async submitCaptureMetadata(captureId, payload) {
    if (this.useMock) return null;
    return this._request(`/captures/${encodeURIComponent(captureId)}/capture-metadata`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  /**
   * saveCaptureMetadata(captureId, metadata) — MOCK MODE ONLY. Adds the capture
   * to the client-side demo queue (mockData.mockQueueItems) that the Local
   * Queue Table and result modal are built around. There is no backend
   * equivalent: in live mode the queue comes from GET /captures and this does
   * nothing.
   */
  async saveCaptureMetadata(captureId, metadata) {
    if (!this.useMock) return null;
    await delay(400);
    let resolvedName = metadata.patientName;
    let resolvedAge = metadata.patientAge;

    if (!resolvedName) {
      try {
        const latest = JSON.parse(localStorage.getItem('netra_latest_patient'));
        if (latest?.name) {
          resolvedName = latest.name;
          resolvedAge = latest.age;
        }
      } catch (e) {}
    }

    const newQueueItem = {
      captureId,
      patientId: metadata.patientId || `PHC001-${Math.random().toString(36).substring(2, 8).toUpperCase()}-NEW1`,
      patientName: resolvedName || 'Krrish',
      patientAge: resolvedAge || 20,
      status: 'result_delivered',
      capturedAt: new Date().toISOString(),
      imagePreviewUrl: metadata.imagePreviewUrl,
      imageUrl: metadata.imagePreviewUrl,
      prediction: metadata.aiPrediction,
    };

    mockData.mockQueueItems.unshift(newQueueItem);
    try {
      const stored = JSON.parse(localStorage.getItem('netra_phc_queue') || '[]');
      localStorage.setItem('netra_phc_queue', JSON.stringify([newQueueItem, ...stored]));
      localStorage.setItem('netra_last_capture', JSON.stringify(newQueueItem));
    } catch (e) {}
    return { success: true, captureId, ...metadata };
  }

  /**
   * getQueue() — the contract's queue is GET /captures. Real rows report their
   * lifecycle status only (captured / quality_passed / synced …); the local
   * backend never holds a grade, so a real row's "view result" stays disabled
   * rather than showing a fabricated one.
   */
  async getQueue() {
    if (this.useMock) {
      await delay(200);
      try {
        const stored = JSON.parse(localStorage.getItem('netra_phc_queue') || '[]');
        if (stored && stored.length > 0) {
          const existingIds = new Set(mockData.mockQueueItems.map(q => q.captureId));
          const additions = stored.filter(q => !existingIds.has(q.captureId));
          return [...additions, ...mockData.mockQueueItems];
        }
      } catch (e) {}
      return [...mockData.mockQueueItems];
    }
    const data = await this._request('/captures');
    if (!Array.isArray(data)) throw new ApiError('bad_response', 'The capture list response was not a list.');
    return data;
  }

  async getSyncStatus() {
    if (this.useMock) {
      // Don't delay sync status checks as they might be polled
      return { ...mockData.mockSyncStatus };
    }
    const data = await this._request('/sync/status', {}, 3000);
    if (!data || typeof data.online !== 'boolean') {
      throw new ApiError('bad_response', 'The sync-status response did not have the expected shape.');
    }
    return data;
  }
}

export const localApi = new LocalApiClient();
