'use strict';

/**
 * matlabSessionClient.js -- the persistent MATLAB inference session
 * (ml-pipeline/inference/matlabSession/runMatlabInferenceSession.m), addressed
 * through the shared file protocol in sessionClient.js.
 *
 *   const { alive, call } = require('./matlabSessionClient');
 *   const body = await call({ tensorPath, gradcamPath }, { timeoutMs: 30_000 });
 *
 * Four request types go through here: Branch A inference, a segmentation
 * forward pass (§S), the clinical-rationale PDF (§O), and the per-case grading
 * pipeline (runCasePipeline.m). The session's own file documents each.
 */

const path = require('path');
const { createSessionClient } = require('./sessionClient');

// Overridable for the same reason MATLAB_HEARTBEAT_PATH is: a real session on
// this machine is polling the live directory, so a test that wrote a request
// there would have it answered for real instead of exercising the protocol.
const SESSION_DIR = process.env.MATLAB_SESSION_DIR
  || path.join(__dirname, '..', 'ml-pipeline', 'inference', 'matlabSession');
// The same override the supervisor honours, so a test can point both at its
// own file instead of a live session's (see matlabSessionSupervisor.js).
const HEARTBEAT = process.env.MATLAB_HEARTBEAT_PATH
  || path.join(SESSION_DIR, 'session.heartbeat');

const client = createSessionClient({
  dir: SESSION_DIR,
  heartbeatFile: HEARTBEAT,
  staleMs: Number(process.env.MATLAB_HEARTBEAT_STALE_MS) > 0
    ? Number(process.env.MATLAB_HEARTBEAT_STALE_MS) : 30_000,
  label: 'MATLAB session',
});

/**
 * call() adds the one thing the generic client cannot know: how to tell
 * someone to start THIS worker. The generic timeout says only that nothing
 * answered.
 */
async function call(payload, opts) {
  try {
    return await client.call(payload, opts);
  } catch (err) {
    if (err.code === 'session_timeout') {
      err.code = 'matlab_session_timeout';
      err.message += ' Is it running? See ml-pipeline/inference/matlabSession/'
        + 'README.md (start it with manageMatlabSession.ps1 start).';
    }
    throw err;
  }
}

module.exports = {
  alive: client.alive,
  call,
  SESSION_DIR,
  REQUEST_DIR: client.REQUEST_DIR,
  RESPONSE_DIR: client.RESPONSE_DIR,
  HEARTBEAT,
};
