// ── Central System Mock Data — shapes match api-contracts.md exactly ──

export const mockOphthQueue = [
  {
    caseId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    patientReference: 'PT-4821',
    patientName: 'Krrish',
    patientAge: 20,
    phcName: 'PHC Kharadi',
    capturedAt: '2026-09-10T09:05:00.000Z',
    drGradeCnn: 2,
    drGradeRuleEngine: 3,
    branchAgreement: false,
    confidenceScore: 0.81,
    conformalTier: 'C',
    priorityRank: 1,
    reviewStatus: 'pending',
  },
  {
    caseId: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
    patientReference: 'PT-3190',
    phcName: 'PHC Wagholi',
    capturedAt: '2026-09-06T08:45:00.000Z',
    drGradeCnn: 3,
    drGradeRuleEngine: 3,
    branchAgreement: true,
    confidenceScore: 0.64,
    conformalTier: 'C',
    priorityRank: 2,
    reviewStatus: 'pending',
  },
  {
    caseId: 'c3d4e5f6-a7b8-9012-cdef-123456789012',
    patientReference: 'PT-7712',
    phcName: 'PHC Hadapsar',
    capturedAt: '2026-09-06T07:30:00.000Z',
    drGradeCnn: 1,
    drGradeRuleEngine: null,
    branchAgreement: null,
    confidenceScore: 0.93,
    conformalTier: 'B',
    priorityRank: 101,
    reviewStatus: 'pending',
  },
  {
    caseId: 'd4e5f6a7-b8c9-0123-defa-234567890123',
    patientReference: 'PT-2056',
    phcName: 'PHC Lohegaon',
    capturedAt: '2026-09-05T16:20:00.000Z',
    drGradeCnn: 4,
    drGradeRuleEngine: 4,
    branchAgreement: true,
    confidenceScore: 0.72,
    conformalTier: 'C',
    priorityRank: 3,
    reviewStatus: 'pending',
  },
  {
    caseId: 'e5f6a7b8-c9d0-1234-efab-345678901234',
    patientReference: 'PT-9145',
    phcName: 'PHC Kharadi',
    capturedAt: '2026-09-05T14:10:00.000Z',
    drGradeCnn: 0,
    drGradeRuleEngine: null,
    branchAgreement: null,
    confidenceScore: 0.97,
    conformalTier: 'B',
    priorityRank: 102,
    reviewStatus: 'pending',
  },
  {
    caseId: 'f6a7b8c9-d0e1-2345-fabc-456789012345',
    patientReference: 'PT-1338',
    phcName: 'PHC Wagholi',
    capturedAt: '2026-09-05T11:55:00.000Z',
    drGradeCnn: 2,
    drGradeRuleEngine: 2,
    branchAgreement: true,
    confidenceScore: 0.88,
    conformalTier: 'B',
    priorityRank: 103,
    reviewStatus: 'pending',
  },
];

export const mockCaseDetail = {
  caseId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  patientReference: 'PT-4821',
  patientName: 'Krrish',
  patientAge: 20,
  imageUrl: null, // We'll generate a placeholder
  gradCamOverlayUrl: null, // We'll generate a placeholder
  lesionCounts: { microaneurysms: 6, hemorrhages: 2, hardExudates: 0, softExudates: 0 },
  nvSuspicionScore: 0.12,
  evidenceSummaryText: '6 microaneurysms (superior-temporal: 3, inferior-nasal: 3), 2 dot hemorrhages. Severe-NPDR criteria not met.',
  drGradeCnn: 2,
  drGradeRuleEngine: 3,
  branchAgreement: false,
  confidenceScore: 0.81,
  uncertaintyScore: 0.34,
  conformalTier: 'C',
  lesionAttentionConsistencyScore: 0.71,
  questionnaireData: {
    riskFactors: {
      yearsSinceDiagnosis: '5to10',
      glycemicControl: 'moderate',
      bloodPressure: 'high',
      pregnant: null,
    },
    symptoms: {
      blurredVision: true,
      floaters: false,
      suddenVisionChange: false,
      eyePain: false,
    },
    language: 'hi',
  },
  captureMetadata: {
    cameraDeviceReported: 'forus_3nethra_v2',
    pupilStatus: 'dilated',
    lightingEnvironment: 'indoor_clinic',
    observedIssues: ['none_noticed'],
    workerUsabilityRating: 'clear',
  },
  priorAssessments: [
    { 
      caseId: 'prev-case-001', 
      gradedAt: '2026-06-01T10:00:00.000Z', 
      drGradeCnn: 1,
      status: 'CONFIRMED',
      referralStatus: 'Seen',
      lesions: {
        microaneurysms: 2,
        hemorrhages: 0,
        hardExudates: 0,
        softExudates: 0
      }
    },
    { 
      caseId: 'prev-case-002', 
      gradedAt: '2026-03-15T09:30:00.000Z', 
      drGradeCnn: 0,
      status: 'OVERRIDDEN (AI: 0)',
      referralStatus: 'Seen',
      lesions: {
        microaneurysms: 0,
        hemorrhages: 0,
        hardExudates: 0,
        softExudates: 0
      }
    },
  ],
};

// Additional case details for other cases
export const mockCaseDetails = {
  'a1b2c3d4-e5f6-7890-abcd-ef1234567890': mockCaseDetail,
  'b2c3d4e5-f6a7-8901-bcde-f12345678901': {
    ...mockCaseDetail,
    caseId: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
    patientReference: 'PT-3190',
    drGradeCnn: 3,
    drGradeRuleEngine: 3,
    branchAgreement: true,
    confidenceScore: 0.64,
    uncertaintyScore: 0.51,
    conformalTier: 'C',
    lesionCounts: { microaneurysms: 12, hemorrhages: 5, hardExudates: 3, softExudates: 1 },
    nvSuspicionScore: 0.38,
    lesionAttentionConsistencyScore: 0.62,
    evidenceSummaryText: '12 microaneurysms scattered across quadrants, 5 blot hemorrhages (predominantly inferior), 3 hard exudates near macula. Approaching PDR threshold.',
    priorAssessments: [],
  },
  'd4e5f6a7-b8c9-0123-defa-234567890123': {
    ...mockCaseDetail,
    caseId: 'd4e5f6a7-b8c9-0123-defa-234567890123',
    patientReference: 'PT-2056',
    drGradeCnn: 4,
    drGradeRuleEngine: 4,
    branchAgreement: true,
    confidenceScore: 0.72,
    uncertaintyScore: 0.42,
    conformalTier: 'C',
    lesionCounts: { microaneurysms: 18, hemorrhages: 8, hardExudates: 5, softExudates: 3 },
    nvSuspicionScore: 0.79,
    lesionAttentionConsistencyScore: 0.55,
    evidenceSummaryText: 'Extensive neovascularization detected. 18 microaneurysms, 8 hemorrhages including vitreous, 5 hard exudates encroaching on macula. PDR confirmed.',
    questionnaireData: {
      ...mockCaseDetail.questionnaireData,
      riskFactors: { yearsSinceDiagnosis: 'gt10', glycemicControl: 'poor', bloodPressure: 'high', pregnant: false },
      symptoms: { blurredVision: true, floaters: true, suddenVisionChange: true, eyePain: false },
    },
    priorAssessments: [
      { 
        caseId: 'prev-case-010', 
        gradedAt: '2026-07-01T10:00:00.000Z', 
        drGradeCnn: 3,
        status: 'CONFIRMED',
        referralStatus: 'Seen',
        lesions: { microaneurysms: 10, hemorrhages: 4, hardExudates: 2, softExudates: 1 }
      },
      { 
        caseId: 'prev-case-011', 
        gradedAt: '2026-04-01T10:00:00.000Z', 
        drGradeCnn: 2,
        status: 'CONFIRMED',
        referralStatus: 'Seen',
        lesions: { microaneurysms: 5, hemorrhages: 1, hardExudates: 0, softExudates: 0 }
      },
      { 
        caseId: 'prev-case-012', 
        gradedAt: '2025-12-01T10:00:00.000Z', 
        drGradeCnn: 1,
        status: 'CONFIRMED',
        referralStatus: 'Seen',
        lesions: { microaneurysms: 1, hemorrhages: 0, hardExudates: 0, softExudates: 0 }
      },
    ],
  },
};

export const mockAdminDashboard = {
  casesToday: 42,
  casesThisWeek: 187,
  totalCasesProcessed: 1284,
  averageReviewTurnaroundSeconds: 27,
  modelAccuracy: 0.946,
  overrideRate: 0.083,
  imagesRejectedQuality: 38,
  qualityRejectionRate: 0.029,
  avgConfidenceScore: 0.924,
  casesPerPhc: [
    { phcId: 'PHC001', phcName: 'PHC Kharadi', count: 18 },
    { phcId: 'PHC002', phcName: 'PHC Wagholi', count: 14 },
    { phcId: 'PHC003', phcName: 'PHC Hadapsar', count: 9 },
    { phcId: 'PHC004', phcName: 'PHC Lohegaon', count: 7 },
  ],
  drGradeDistribution: [
    { grade: 0, label: 'No DR', count: 312, percentage: 24.3 },
    { grade: 1, label: 'Mild NPDR', count: 445, percentage: 34.7 },
    { grade: 2, label: 'Moderate NPDR', count: 298, percentage: 23.2 },
    { grade: 3, label: 'Severe NPDR', count: 156, percentage: 12.1 },
    { grade: 4, label: 'PDR', count: 73, percentage: 5.7 },
  ],
  weeklyTrend: [
    { week: 'W31', cases: 32, referrals: 4 },
    { week: 'W32', cases: 45, referrals: 6 },
    { week: 'W33', cases: 38, referrals: 5 },
    { week: 'W34', cases: 51, referrals: 8 },
    { week: 'W35', cases: 48, referrals: 7 },
    { week: 'W36', cases: 42, referrals: 6 },
  ],
};

export const mockReferrals = [
  { referralId: 'ref-001', patientReference: 'PT-4821', patientName: 'Krrish', patientAge: 20, status: 'manual_follow_up', failureReason: 'SMS gateway timeout (No cell coverage)', assignedWorker: 'ASHA-042', updatedAt: '2026-09-10T09:20:00.000Z', phcName: 'PHC Kharadi', drGrade: 3, phone: '+91 98230 44821' },
  { referralId: 'ref-002', patientReference: 'PT-2056', status: 'contacted', assignedWorker: 'ASHA-112', updatedAt: '2026-09-05T16:30:00.000Z', phcName: 'PHC Lohegaon', drGrade: 4, phone: '+91 98765 43210' },
  { referralId: 'ref-003', patientReference: 'PT-3190', status: 'attended', assignedWorker: 'ASHA-087', updatedAt: '2026-09-04T11:00:00.000Z', phcName: 'PHC Wagholi', drGrade: 3, phone: '+91 94220 11223' },
  { referralId: 'ref-004', patientReference: 'PT-6621', status: 'lost', assignedWorker: 'ASHA-045', updatedAt: '2026-08-28T14:00:00.000Z', phcName: 'PHC Hadapsar', drGrade: 2, phone: '+91 98900 33445' },
  { referralId: 'ref-005', patientReference: 'PT-1102', status: 'referred', assignedWorker: null, updatedAt: '2026-09-06T08:00:00.000Z', phcName: 'PHC Kharadi', drGrade: 4, phone: '+91 97654 22334' },
  { referralId: 'ref-006', patientReference: 'PT-7803', status: 'manual_follow_up', failureReason: 'Undelivered (Handset switched off > 24h)', assignedWorker: 'ASHA-112', updatedAt: '2026-09-05T10:15:00.000Z', phcName: 'PHC Wagholi', drGrade: 3, phone: '+91 91234 56789' },
  { referralId: 'ref-007', patientReference: 'PT-9941', status: 'referred', assignedWorker: null, updatedAt: '2026-09-06T11:45:00.000Z', phcName: 'PHC Alandi', drGrade: 3, phone: '+91 98112 34567' },
  { referralId: 'ref-008', patientReference: 'PT-5532', status: 'attended', assignedWorker: 'ASHA-094', updatedAt: '2026-09-03T15:20:00.000Z', phcName: 'PHC Lohegaon', drGrade: 4, phone: '+91 94030 99887' },
  { referralId: 'ref-009', patientReference: 'PT-4120', status: 'contacted', assignedWorker: 'ASHA-063', updatedAt: '2026-09-05T14:10:00.000Z', phcName: 'PHC Saswad', drGrade: 2, phone: '+91 98221 44556' },
  { referralId: 'ref-010', patientReference: 'PT-8314', status: 'lost', assignedWorker: 'ASHA-022', updatedAt: '2026-08-25T09:30:00.000Z', phcName: 'PHC Khed', drGrade: 3, phone: '+91 98505 11224' },
  { referralId: 'ref-011', patientReference: 'PT-6288', status: 'referred', assignedWorker: null, updatedAt: '2026-09-06T07:15:00.000Z', phcName: 'PHC Wagholi', drGrade: 4, phone: '+91 99700 88776' },
  { referralId: 'ref-012', patientReference: 'PT-1944', status: 'attended', assignedWorker: 'ASHA-087', updatedAt: '2026-09-02T13:40:00.000Z', phcName: 'PHC Kharadi', drGrade: 3, phone: '+91 98230 66778' },
];

export const mockPhcSyncStatuses = [
  { phcId: 'PHC001', phcName: 'PHC Kharadi', lastSyncAt: '2026-09-06T09:10:00.000Z', pendingCount: 0, totalScreened: 456, status: 'online', hoursSilent: 0 },
  { phcId: 'PHC002', phcName: 'PHC Wagholi', lastSyncAt: '2026-09-06T08:45:00.000Z', pendingCount: 3, totalScreened: 312, status: 'online', hoursSilent: 1 },
  { phcId: 'PHC003', phcName: 'PHC Hadapsar', lastSyncAt: '2026-09-03T22:00:00.000Z', pendingCount: 12, totalScreened: 189, status: 'offline', hoursSilent: 58 },
  { phcId: 'PHC004', phcName: 'PHC Lohegaon', lastSyncAt: '2026-09-06T07:00:00.000Z', pendingCount: 1, totalScreened: 327, status: 'online', hoursSilent: 2 },
  { phcId: 'PHC005', phcName: 'PHC Alandi', lastSyncAt: '2026-09-06T09:05:00.000Z', pendingCount: 0, totalScreened: 245, status: 'online', hoursSilent: 0 },
  { phcId: 'PHC006', phcName: 'PHC Saswad', lastSyncAt: '2026-09-03T18:30:00.000Z', pendingCount: 8, totalScreened: 164, status: 'offline', hoursSilent: 52 },
  { phcId: 'PHC007', phcName: 'PHC Khed', lastSyncAt: '2026-09-06T08:15:00.000Z', pendingCount: 2, totalScreened: 298, status: 'online', hoursSilent: 1 },
];

export const mockResourceRecommendations = {
  generatedAt: new Date().toISOString(),
  minOphthalmologistsRoutine: 2,
  minOphthalmologistsCamp: 4,
  maxSearched: 12,
  p95TargetMin: 60,
  bottleneck: 'ophthalmologist review',
  recommendation: 'Reviewer pool is the constraint (72% utilised, p95 wait 72 min). Add ophthalmologists: 1 -> 2.',
  current: {
    numOphthalmologists: 1,
    reviewUtilisationPct: 72,
    reviewWaitP95Min: 72,
    uploadUtilisationPct: 34,
    uploadWaitP95Min: 18,
    casesReviewed: 824,
    casesAutoCleared: 460,
  },
  params: {
    arrivalRatePerDay: 48,
    reviewServiceRateMinutes: 12,
    workingHoursPerDay: 8,
    campMultiplier: 2.5,
  },
  inputsSource: {
    tierFractions: 'observed: 43 graded cases, last 90 days',
    reviewServiceTime: 'observed: average 27 seconds (quick triage) to 14 minutes (detailed review)',
    arrivalPattern: 'modelled defaults: peak 10:00 - 14:00 IST',
  },
  model: 'referenceQueueingModel.m (Simulink-Validated)',
  runSeconds: 2.0,
};

export const mockSimulinkValidation = {
  ranAt: '2026-09-20T03:00:00Z',
  status: 'agree', // "agree" | "diverged" | "error"
  checks: [
    { metric: 'Auto-clear share (Tier A)', simEvents: 71.0, reference: 68.4, tolerance: 5.0, unit: '%', agree: true },
    { metric: 'Reviewer utilisation', simEvents: 74.2, reference: 72.0, tolerance: 5.0, unit: '%', agree: true },
    { metric: 'Mean review wait time', simEvents: 24.5, reference: 26.1, tolerance: 10.0, unit: 'min', agree: true },
    { metric: 'Queue buffer p95 depth', simEvents: 8.0, reference: 7.6, tolerance: 2.0, unit: 'cases', agree: true },
  ],
  simEvents: {
    tierAAutoCleared: 460,
    reviewed: 824,
    uploadUtilisation: 34.0,
    reviewerUtilisation: 74.2,
    reviewWaitMeanSec: 1470,
  },
  reference: {
    casesSimulated: 1284,
    casesAutoCleared: 460,
    casesReviewed: 824,
    uploadUtilisation: 34.0,
    reviewUtilisation: 72.0,
    reviewWaitMeanMin: 26.1,
  },
  params: { simulationDays: 30, rngSeed: 42 },
  simSeconds: 31,
  note: 'All parameters are modelled assumptions, not measured field data.',
};

export const mockSystemHealth = {
  silentPhcs: [
    { phcId: 'PHC003', phcName: 'PHC Hadapsar', lastContactAt: '2026-09-03T22:00:00.000Z', hoursSilent: 58 },
    { phcId: 'PHC006', phcName: 'PHC Saswad', lastContactAt: '2026-09-03T18:30:00.000Z', hoursSilent: 52 },
  ],
  stuckJobs: [
    { caseId: 'job-9821-sync', stuckSince: '2026-09-21T21:40:00.000Z', minutesStuck: 18, autoRecoveredCount: 1, lastRecoveredAt: '2026-09-21T21:45:00.000Z', autoRecoveryExhausted: false },
  ],
  matlabSessionStatus: 'healthy',
  matlabSession: {
    status: 'healthy',
    lastHeartbeatAt: new Date().toISOString(),
    restartsInWindow: 0,
    lastError: null,
    pid: 14092,
  },
  unreviewedCases: [
    { caseId: 'd4e5f6a7-b8c9-0123-defa-234567890123', patientReference: 'PT-2056', tier: 'C', drGrade: 4, createdAt: '2026-09-18T10:00:00.000Z', hoursUnreviewed: 51 },
  ],
  alerts: [
    { kind: 'silent_phc', subject: 'PHC Hadapsar (PHC003)', message: 'No synchronization heartbeat received for 58 hours (threshold: 48h). Send field engineer or check regional power.', firstSeenAt: '2026-09-05T22:00:00Z', occurrences: 1 },
    { kind: 'unreviewed_sla', subject: 'Case PT-2056 (PDR / Grade 4)', message: 'Referable DR case unreviewed for 51 hours, breaching the 48-hour national clinical SLA.', firstSeenAt: '2026-09-20T10:00:00Z', occurrences: 1 },
  ],
  thresholds: {
    silentPhcHours: 24,
    stuckJobMinutes: 15,
    unreviewedCaseHours: 48,
  },
  generatedAt: new Date().toISOString(),
};

export const drGradeLabels = {
  0: 'No DR',
  1: 'Mild NPDR',
  2: 'Moderate NPDR',
  3: 'Severe NPDR',
  4: 'PDR',
};

export const overrideReasonCategories = [
  { value: 'artifact_misread', label: 'Artifact Misread' },
  { value: 'lesion_missed', label: 'Lesion Missed' },
  { value: 'wrong_severity', label: 'Wrong Severity' },
  { value: 'image_quality_issue', label: 'Image Quality Issue' },
];
