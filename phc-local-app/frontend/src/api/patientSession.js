// The patient questionnaire is answered once, at registration, and then attached
// to every capture of that patient (POST /captures/:captureId/questionnaire).
// It is kept per patientId: the capture screen used to read "the latest
// registered patient", so opening a capture for any other patient sent that
// other person's answers.

const KEY = 'netra_patient_questionnaires';

function readAll() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { return {}; }
}

export function saveQuestionnaire(patientId, questionnaire) {
  try {
    const all = readAll();
    all[patientId] = questionnaire;
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch { /* storage blocked: the capture screen will then ask for the answers again */ }
}

/** The stored answers for THIS patient, or null. Never another patient's. */
export function loadQuestionnaire(patientId) {
  const q = readAll()[patientId];
  return q && typeof q === 'object' ? q : null;
}
