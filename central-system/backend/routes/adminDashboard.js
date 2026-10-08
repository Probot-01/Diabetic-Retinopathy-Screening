'use strict';

/**
 * routes/adminDashboard.js  (Task 3.7)
 *
 * Mounted at /api/v1/admin.
 *
 *   GET /api/v1/admin/dashboard -> { casesToday, casesPerPhc, averageReviewTurnaroundSeconds }
 *   GET /api/v1/admin/referrals -> [ { referralId, patientReference, status,
 *                                      assignedWorker, updatedAt } ]
 *   GET /api/v1/admin/system-health -> { silentPhcs, stuckJobs, matlabSessionStatus,
 *                                        unreviewedCases, ... }  (backend plan §F)
 *   GET  /api/v1/admin/resource-recommendations          latest model output (§G)
 *   POST /api/v1/admin/resource-recommendations/refresh  re-run the model now
 *   GET  /api/v1/admin/simulink-validation               is that model still
 *                                                        validated? (§G.2)
 *   POST /api/v1/admin/simulink-validation/refresh       re-run the .slx now
 *
 * Thin by intent: the SQL lives in services/analyticsAggregator.js so the
 * queries can be read and changed in one place, and so the timezone handling in
 * "cases today" is not buried in a route handler.
 *
 * Aggregate-only (design doc §1.6). No per-case detail and no per-case push
 * belongs on these endpoints.
 */

const express = require('express');
const analytics = require('../services/analyticsAggregator');
const requireAuth = require('../middleware/requireAuth');
const requireRole = require('../middleware/requireRole');
const { logAccess } = require('../services/accessLog');
const { getSystemHealth } = require('../services/systemHealth');
const resourceModel = require('../services/resourceRecommendations');
const simulinkValidation = require('../services/simulinkValidation');

const router = express.Router();

// District-admin only (§A.7). Every route in this file is admin-facing.
const adminOnly = [requireAuth, requireRole('district_admin')];

router.get('/dashboard', adminOnly, async (req, res, next) => {
  try {
    const body = await analytics.getDashboard();
    await logAccess(req.user?.userId, 'view_dashboard', 'dashboard');
    res.json(body);
  } catch (err) { next(err); }
});

router.get('/referrals', adminOnly, async (req, res, next) => {
  try {
    const body = await analytics.getReferrals();
    await logAccess(req.user?.userId, 'view_referrals', 'referral_list');
    res.json(body);
  } catch (err) { next(err); }
});

// Every PHC site with its recent activity. The API key / hash are never part of
// the response (analytics.getPhcs does not select them).
router.get('/phcs', adminOnly, async (req, res, next) => {
  try {
    const body = await analytics.getPhcs();
    await logAccess(req.user?.userId, 'view_phcs', 'phc_list');
    res.json(body);
  } catch (err) { next(err); }
});

router.get('/system-health', adminOnly, async (req, res, next) => {
  try {
    const body = await getSystemHealth();
    await logAccess(req.user?.userId, 'view_system_health', 'system_health');
    res.json(body);
  } catch (err) { next(err); }
});

// §G. 404 until the model has run once -- the daily job, or the refresh below.
// A 404 rather than an empty 200: the panel must be able to say "no
// recommendation yet" instead of rendering blanks as if they were an answer.
router.get('/resource-recommendations', adminOnly, async (req, res, next) => {
  try {
    const body = await resourceModel.latest();
    if (!body) {
      return res.status(404).json({
        error: 'recommendations_not_generated',
        message: 'The resource model has not run yet. POST /api/v1/admin/' +
                 'resource-recommendations/refresh, or wait for the daily run.',
      });
    }
    res.json(body);
  } catch (err) { next(err); }
});

// Runs the model now and returns the new row. Takes tens of seconds (a MATLAB
// start plus the simulations); concurrent calls share one run.
router.post('/resource-recommendations/refresh', adminOnly, async (req, res, next) => {
  try {
    const body = await resourceModel.refresh();
    await logAccess(req.user?.userId, 'refresh_resource_model', 'resource_recommendations');
    res.json(body);
  } catch (err) {
    res.status(502).json({ error: 'resource_model_failed', message: err.message });
  }
});

// §G.2's other half. The recommendations above come from the reference
// queueing model; its right to be believed comes from agreeing with the
// SimEvents deliverable. This says when that was last checked and how it went,
// so a panel can show the recommendation WITH its validation rather than
// implying one.
router.get('/simulink-validation', adminOnly, async (req, res, next) => {
  try {
    const body = simulinkValidation.latest();
    if (!body) {
      return res.status(404).json({
        error: 'validation_not_run',
        message: 'The SimEvents validation has not run on this machine yet. It runs '
               + 'weekly; POST /api/v1/admin/simulink-validation/refresh to run it now.',
      });
    }
    res.json(body);
  } catch (err) { next(err); }
});

// Minutes, not seconds: it loads Simulink and simulates the whole model.
// Concurrent calls share one run.
router.post('/simulink-validation/refresh', adminOnly, async (req, res, next) => {
  try {
    const body = await simulinkValidation.refresh();
    await logAccess(req.user?.userId, 'refresh_simulink_validation', 'simulink_validation');
    res.json(body);
  } catch (err) {
    res.status(502).json({ error: 'simulink_validation_failed', message: err.message });
  }
});

module.exports = router;
