'use strict';

/**
 * phcSilence.js -- the ONE definition of a "silent" PHC.
 *
 * A PHC is silent when it has made no contact of any kind (a full case, a
 * summary packet, a chunk, any authenticated PHC call: phc_sites.last_contact_at)
 * within PHC_SILENT_HOURS (default 24), or has never made contact at all.
 *
 * Both the System Health card (GET /admin/system-health -> silentPhcs) and the
 * PHC Health page (GET /admin/phcs -> status) use isSilent() below, so their
 * counts cannot disagree. Do not add a second threshold or a second signal.
 */

const PHC_SILENT_HOURS = (() => {
  const v = Number(process.env.PHC_SILENT_HOURS);
  return Number.isFinite(v) && v > 0 ? v : 24;
})();

/** @param {Date|null} lastContactAt  phc_sites.last_contact_at */
function isSilent(lastContactAt, now = Date.now()) {
  return !lastContactAt || lastContactAt.getTime() < now - PHC_SILENT_HOURS * 3_600_000;
}

module.exports = { PHC_SILENT_HOURS, isSilent };
