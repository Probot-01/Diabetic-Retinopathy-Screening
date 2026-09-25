import { USE_MOCK_DATA, CENTRAL_API_BASE } from '../config';
import * as mockData from './mockData';

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const REAL_CALL_TIMEOUT_MS = 6000;
const localMockReviews = {};

/**
 * ApiError — what every live-mode failure rejects with. `code` is the
 * contract's snake_case `error` field (api-contracts.md, "Error shape") or a
 * client-side code (network_error, timeout, config_missing, not_available,
 * bad_response); screens branch on `code` and display `message`.
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
 * DATA MODE (config.js): mock mode serves fixtures from mockData.js and nothing
 * else; live mode serves the central API and nothing else. A live request that
 * fails REJECTS: no fallback to fixtures, no "an empty queue looks broken, show
 * the demo one", no fabricated success (design doc §1.22). Every screen that
 * calls this client renders the rejection as an error state.
 */
class CentralApiClient {
  constructor() {
    this.baseUrl = CENTRAL_API_BASE;
  }

  async _fetch(path, options = {}, timeoutMs = REAL_CALL_TIMEOUT_MS) {
    if (!this.baseUrl) {
      throw new ApiError('config_missing',
        'VITE_CENTRAL_API_BASE is not set, so this app does not know where the central server is. ' +
        'Set it in central-system/frontend/.env and restart the dev server.');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...options.headers },
        // The session is an httpOnly cookie (api-contracts.md, "Rules for
        // every browser call"); without this it is never sent.
        credentials: 'include',
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new ApiError('timeout', `The central server did not answer within ${Math.round(timeoutMs / 1000)} s (${path}).`);
      }
      throw new ApiError('network_error', `Cannot reach the central server at ${this.baseUrl}. Is it running?`);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new ApiError(body?.error || `http_${res.status}`,
        body?.message || `${res.status} ${res.statusText} from ${path}`, res.status);
    }
    return res.json();
  }

  // ── Ophthalmologist ──

  async getOphthQueue() {
    if (USE_MOCK_DATA) {
      await delay(400);
      const list = [...mockData.mockOphthQueue];
      try {
        const latest = JSON.parse(localStorage.getItem('netra_latest_patient'));
        if (latest?.name) {
          list[0] = {
            ...list[0],
            patientName: latest.name,
            patientAge: latest.age || 20,
            patientReference: latest.patientId ? (latest.patientId.length > 10 ? latest.patientId.substring(0, 10).toUpperCase() : latest.patientId) : 'PT-4821',
          };
        }
      } catch (e) {}
      return list;
    }
    // An empty array is a real answer (nothing awaiting review) and is
    // returned as such.
    const data = await this._fetch('/api/v1/ophthalmologist/queue');
    if (!Array.isArray(data)) {
      throw new ApiError('bad_response', 'The review queue response was not a list.');
    }
    return data;
  }

  async getCaseDetail(caseId) {
    if (USE_MOCK_DATA) {
      await delay(400);
      const base = mockData.mockCaseDetails[caseId] || { ...mockData.mockCaseDetail, caseId };
      try {
        const latest = JSON.parse(localStorage.getItem('netra_latest_patient'));
        if (latest?.name && (caseId === 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' || !mockData.mockCaseDetails[caseId])) {
          return {
            ...base,
            patientName: latest.name,
            patientAge: latest.age || 20,
            patientReference: latest.patientId ? (latest.patientId.length > 10 ? latest.patientId.substring(0, 10).toUpperCase() : latest.patientId) : 'PT-4821',
          };
        }
      } catch (e) {}
      return base;
    }
    const data = await this._fetch(`/api/v1/cases/${encodeURIComponent(caseId)}`);
    if (!data || typeof data.caseId !== 'string') {
      throw new ApiError('bad_response', 'The case-detail response did not have the expected shape.');
    }
    return data;
  }

  async claimCase(caseId, ophthalmologistId = 'OPHTH-001') {
    if (USE_MOCK_DATA) {
      await delay(300);
      // Simulate a conflict 20% of the time for testing
      if (Math.random() < 0.2) {
        const error = new Error('Conflict: Case already claimed');
        error.status = 409;
        error.claimedBy = 'Dr. Sarah Chen (OPHTH-042)';
        throw error;
      }
      return { success: true };
    }
    await this._fetch(`/api/v1/cases/${encodeURIComponent(caseId)}/claim`, {
      method: 'POST',
      body: JSON.stringify({ ophthalmologistId })
    });
    return { success: true };
  }

  async getReviews(caseId) {
    if (USE_MOCK_DATA) {
      await delay(300);
      if (localMockReviews[caseId] && localMockReviews[caseId].length > 0) {
        return localMockReviews[caseId];
      }
      // Mock prior review for 20% of cases for testing
      if (Math.random() < 0.2) {
        return [{
          reviewId: 'rev-123',
          reviewerName: 'Dr. Arjun Mehta',
          decision: 'override',
          overrideReasonCategory: 'image_quality',
          overrideReasonText: 'Blurry inferior quadrant, unable to grade confidently.',
          correctedGrade: 0,
          reviewedAt: new Date(Date.now() - 3600000).toISOString()
        }];
      }
      return [];
    }
    const data = await this._fetch(`/api/v1/cases/${encodeURIComponent(caseId)}/reviews`);
    if (!Array.isArray(data)) {
      throw new ApiError('bad_response', 'The review-history response was not a list.');
    }
    return data;
  }

  async submitReview(caseId, reviewData) {
    if (USE_MOCK_DATA) {
      await delay(500);
      const reviewId = `review-${Date.now().toString(36)}`;

      const newReview = {
        reviewId,
        reviewerName: reviewData.ophthalmologistId || 'Dr. Krrish Gadekar',
        decision: reviewData.decision,
        overrideReasonCategory: reviewData.overrideReasonCategory,
        overrideReasonText: reviewData.overrideReasonText,
        correctedGrade: reviewData.correctedGrade || reviewData.overrideGrade,
        reviewedAt: new Date().toISOString()
      };

      if (!localMockReviews[caseId]) localMockReviews[caseId] = [];
      localMockReviews[caseId].unshift(newReview);

      const newGrade = reviewData.decision === 'override' ? newReview.correctedGrade : null;

      const qIdx = mockData.mockOphthQueue.findIndex(q => q.caseId === caseId);
      if (qIdx !== -1) {
        mockData.mockOphthQueue[qIdx].reviewStatus = reviewData.decision === 'override' ? 'overridden' : 'confirmed';
        if (reviewData.decision === 'override' && newGrade !== null && newGrade !== undefined) {
          mockData.mockOphthQueue[qIdx].drGradeCnn = newGrade;
          mockData.mockOphthQueue[qIdx].drGradeRuleEngine = newGrade;
          mockData.mockOphthQueue[qIdx].branchAgreement = true;
        } else if (reviewData.decision === 'confirm') {
          mockData.mockOphthQueue[qIdx].drGradeRuleEngine = mockData.mockOphthQueue[qIdx].drGradeCnn;
          mockData.mockOphthQueue[qIdx].branchAgreement = true;
        }
      }

      if (mockData.mockCaseDetails[caseId]) {
        if (reviewData.decision === 'override' && newGrade !== null && newGrade !== undefined) {
          mockData.mockCaseDetails[caseId].drGradeCnn = newGrade;
          mockData.mockCaseDetails[caseId].drGradeRuleEngine = newGrade;
          mockData.mockCaseDetails[caseId].branchAgreement = true;
        } else if (reviewData.decision === 'confirm') {
          mockData.mockCaseDetails[caseId].drGradeRuleEngine = mockData.mockCaseDetails[caseId].drGradeCnn;
          mockData.mockCaseDetails[caseId].branchAgreement = true;
        }
      }

      return { reviewId, referralId: null, smsStatus: null };
    }
    const data = await this._fetch(`/api/v1/cases/${encodeURIComponent(caseId)}/review`, {
      method: 'POST',
      body: JSON.stringify(reviewData),
    });
    if (!data || typeof data.reviewId !== 'string') {
      throw new ApiError('bad_response',
        'The review response did not have the expected shape; the review may not have been recorded.');
    }
    return data;
  }

  // ── District admin ──

  /**
   * Live: GET /api/v1/admin/dashboard, which returns ONLY casesToday,
   * casesPerPhc and averageReviewTurnaroundSeconds (api-contracts.md). Every
   * other figure the dashboards draw exists only in mock mode; in live mode
   * the screens show those as unavailable rather than inventing them.
   */
  async getAdminDashboard() {
    if (USE_MOCK_DATA) {
      await delay(500);
      return { ...mockData.mockAdminDashboard };
    }
    return this._fetch('/api/v1/admin/dashboard');
  }

  async getReferrals() {
    if (USE_MOCK_DATA) {
      await delay(300);
      const list = [...mockData.mockReferrals];
      try {
        const latest = JSON.parse(localStorage.getItem('netra_latest_patient'));
        if (latest?.name) {
          list[0] = {
            ...list[0],
            patientName: latest.name,
            patientAge: latest.age || 20,
          };
        }
      } catch (e) {}
      return list;
    }
    const data = await this._fetch('/api/v1/admin/referrals');
    if (!Array.isArray(data)) {
      throw new ApiError('bad_response', 'The referrals response was not a list.');
    }
    return data;
  }

  async updateReferral(referralId, data) {
    if (USE_MOCK_DATA) {
      await delay(300);
      const idx = mockData.mockReferrals.findIndex(r => r.referralId === referralId);
      if (idx !== -1) {
        mockData.mockReferrals[idx] = {
          ...mockData.mockReferrals[idx],
          ...data,
          updatedAt: new Date().toISOString(),
        };
        return { ...mockData.mockReferrals[idx] };
      }
      return { referralId, ...data, updatedAt: new Date().toISOString() };
    }
    return this._fetch(`/api/v1/referrals/${encodeURIComponent(referralId)}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  }

  /**
   * The contract has a per-site GET /api/v1/phc/:phcId/sync-status but no
   * endpoint that lists every PHC, so live mode has nothing honest to return:
   * this rejects, and the PHC Health page says so.
   */
  async getPhcSyncStatuses() {
    if (USE_MOCK_DATA) {
      await delay(300);
      return [...mockData.mockPhcSyncStatuses];
    }
    throw new ApiError('not_available',
      "The central API has no endpoint that lists every PHC's sync status (api-contracts.md defines only " +
      'GET /api/v1/phc/:phcId/sync-status), so this table has no live data source yet.');
  }

  // ── District Admin Resource Recommendations & System Health ──

  async getResourceRecommendations() {
    if (USE_MOCK_DATA) {
      await delay(400);
      return { ...mockData.mockResourceRecommendations };
    }
    return this._fetch('/api/v1/admin/resource-recommendations');
  }

  async refreshResourceRecommendations() {
    if (USE_MOCK_DATA) {
      await delay(1200); // Simulate model simulation time
      return {
        ...mockData.mockResourceRecommendations,
        generatedAt: new Date().toISOString(),
      };
    }
    return this._fetch('/api/v1/admin/resource-recommendations/refresh', { method: 'POST' }, 35000);
  }

  async getSimulinkValidation() {
    if (USE_MOCK_DATA) {
      await delay(350);
      return { ...mockData.mockSimulinkValidation };
    }
    return this._fetch('/api/v1/admin/simulink-validation');
  }

  async refreshSimulinkValidation() {
    if (USE_MOCK_DATA) {
      await delay(1500);
      return {
        ...mockData.mockSimulinkValidation,
        ranAt: new Date().toISOString(),
      };
    }
    return this._fetch('/api/v1/admin/simulink-validation/refresh', { method: 'POST' }, 60000);
  }

  async getSystemHealth() {
    if (USE_MOCK_DATA) {
      await delay(300);
      return { ...mockData.mockSystemHealth };
    }
    return this._fetch('/api/v1/admin/system-health');
  }
}

export const centralApi = new CentralApiClient();
