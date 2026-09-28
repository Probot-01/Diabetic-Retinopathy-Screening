function out = runCasePipeline(inputPath)
%RUNCASEPIPELINE  The MATLAB half of one case's grading, as a callable function.
%
%   out = runCasePipeline(inputJsonPath)
%
% Everything gradingOrchestrator.js needs back from MATLAB for a single case:
% the camera-family cross-check (Task 6.3), neovascularization suspicion (§J),
% Branch B's rule-engine grade and branch agreement (Tasks 5.1/5.2),
% lesion-attention consistency (Task 7.1) and the evidence sentence (Task 7.3).
%
% ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
% This logic used to be a ~60-statement chain that gradingOrchestrator.js
% assembled into ONE line and handed to `matlab -batch`. That cost a fresh
% MATLAB start on every case -- about 20 s of the ~50 s a case took, paid again
% for each one. As a function it can run inside the already-warm persistent
% session (runMatlabInferenceSession.m), which pays that start once.
%
% Being a real file is worth as much as the speed. The generated one-liner
% needed a semicolon after every `if` and `end` because the whole script was
% joined onto a single line -- two comments in the generator existed only to
% explain that trap. Nothing here can be broken by string concatenation, and it
% can be read, edited and called directly from the MATLAB prompt.
%
% ── INPUT ───────────────────────────────────────────────────────────────────
% A JSON file (gradingOrchestrator.js's buildCasePipelineInput) with:
%   imagePath       the fundus image; anything readFundusImage reads, DICOM too
%   caseId          for the evidence report's header
%   cameraDeviceId  what the worker said the camera was -- cross-check ONLY
%   redQ, brightQ   4 lesion counts per quadrant, or null when segmentation
%                   did not run: the rule engine then refuses to grade rather
%                   than grading an eye nothing looked at
%   vesselPath      segInfer's vessel mask, and opticDisc as [x y], both in
%   odXY            ORIGINAL image pixels (the same frame)
%   ruleOpts        venousBeadingQuadrants / irmaQuadrants / foveaUnreliable,
%                   each present ONLY when genuinely measured (§H, §I)
%   branchAGrade    the classifier's grade, or null
%   camMap          the raw Grad-CAM, and the lesion/ROI masks at Branch A's
%   lesion384Path   384 geometry. Nothing re-derives that geometry here: doing
%   roi384Path      so is how a misaligned mask scores attention against the
%                   wrong pixels and still returns a plausible number.
%
% A missing or null field always means "not available", never a default -- see
% the [] handling throughout. An absent detector signal makes the rule engine
% say the criterion was NOT assessed, which is the whole point of §H: an
% all-false mock must never be passed in to make the evidence text look
% complete.
%
% ── OUTPUT ──────────────────────────────────────────────────────────────────
% One struct, encoded by the caller with jsonencodeAscii (NOT jsonencode:
% stdout on Windows is the ANSI code page, which silently drops the em dashes
% the evidence text is full of -- see ml-pipeline/inference/jsonencodeAscii.m).
% Every "did not run" value is [], which jsonencode renders as null, so it
% reaches Postgres as NULL and never as a measured 0 or false.

req = jsondecode(fileread(inputPath));

% ── Task 4.6: readFundusImage, not imread ───────────────────────────────────
% Desktop fundus cameras export the Ophthalmic Photography IOD, not JPEG; until
% this went in, such a file could not have been graded at all. Ordinary images
% take the identical imread path.
imagePath = reqStr(req, 'imagePath');
[img, imgMeta] = readFundusImage(imagePath);

% ── Task 6.3: camera family ─────────────────────────────────────────────────
% The worker-reported device is passed in for the CROSS-CHECK only, never to
% steer classification: the pixels are what the model actually sees, so image
% evidence wins and a disagreement is reported rather than resolved in favour
% of the paperwork (design doc §9.4).
%
% A DICOM file names the device that took the photograph, which is better
% evidence than the worker's dropdown -- and it is deliberately NOT substituted
% here. classifyCameraFamily matches against a table of known device keys, and
% a free-text DICOM string ("Topcon TRC-NW400") matches nothing, so
% substituting it would silently SUPPRESS this check rather than improve it.
% The device is recorded as evidence instead, in out.dicomDeviceModel.
[cameraFamily, cameraDetail] = classifyCameraFamily(img, reqStr(req, 'cameraDeviceId'));

% ── §J: neovascularization suspicion ────────────────────────────────────────
% nvScore stays [] when it could not run -- reported as NULL, never as a
% measured 0.
%
% The rule engine now gets 0 ALWAYS (nvForRule), not just when the score is
% missing: the score failed its validation and must not decide anything. See
% the note at the assignment below for the numbers and the reason.
vesselPath = reqStr(req, 'vesselPath');
odXY       = reqRow(req, 'odXY', 2);
nvScore = [];
nvForRule = 0;
if isfile(vesselPath) && numel(odXY) == 2
    [nvS, nvDetail] = neovascularizationSuspicion(imread(vesselPath) > 127, odXY);
    if nvDetail.valid
        nvScore = nvS;
        % nvForRule DELIBERATELY STAYS 0 -- the score is reported, never graded on.
        %
        % The score was validated against ground truth and FAILED (Tanuj, ML
        % Layer Final Report, 2026-09-21): AUC 0.286 separating PDR on IDRiD
        % test (n=103) and 0.379 on Messidor-2 (n=1,744). Both are at or below
        % chance, so the design's 0.6 threshold for asserting grade 4 has no
        % support. The cause was investigated rather than guessed: the vessel
        % model is trained on healthy CHASE_DB1 retinas and segments LESS
        % vessel signal on more diseased ones, a confound that runs opposite to
        % the NV signal the score tries to isolate.
        %
        % Feeding it in was bounded -- ruleEngineGrade caps at 3 -- but not
        % harmless: above 0.6 it changed the criterion that fired and set
        % isLowerBound, which can escalate a case's tier. A worse-than-chance
        % signal must not move a grade or a tier at all.
        %
        % The measured value still reaches the caller as out.nvSuspicionScore,
        % so the signal stays visible and auditable; it simply decides nothing.
        % TO RE-ENABLE: this needs a detector that separates PDR above chance,
        % not a threshold change -- set nvForRule = nvS then, and only then.
    end
end

% ── Branch B (Tasks 5.1/5.2) ────────────────────────────────────────────────
% Counts come from segInfer.py, computed in CROP-512 with a 10 px minimum
% component area -- the exact procedure the ICDR thresholds were calibrated
% against (verifyRuleEngineCounts.py: 14/14 on sum(red), and the same
% rule-engine grade on 14/14).
redQ         = reqRow(req, 'redQ', 4);
brightQ      = reqRow(req, 'brightQ', 4);
ruleOpts     = reqRuleOpts(req);
branchAGrade = reqScalar(req, 'branchAGrade');

ruleGrade        = [];
branchAgree      = [];
evidenceInputs   = struct();
ruleIsLowerBound = false;
ruleMaxGrade     = [];
if numel(redQ) == 4 && numel(brightQ) == 4
    [ruleGrade, ruleEvidence] = ruleEngineGrade(redQ, brightQ, nvForRule, ruleOpts);
    evidenceInputs = struct('redByQuadrant', redQ, 'brightByQuadrant', brightQ, ...
                            'nvSuspicionScore', nvForRule);
    % branchesAgree returns [] -- NOT false -- when either branch is missing.
    % false means "compared and disagreed" and forces mandatory review; []
    % means "Branch B did not run". Collapsing them would send every
    % segmentation failure to the review queue as though something were wrong
    % with the eye.
    branchAgree      = branchesAgree(branchAGrade, ruleGrade, ruleEvidence.isLowerBound);
    ruleIsLowerBound = ruleEvidence.isLowerBound;
    ruleMaxGrade     = ruleEvidence.maxGrade;
end

% ── Task 7.1: lesion-attention consistency ──────────────────────────────────
% Everything arrives pre-aligned in Branch A's 384 frame, so the only thing
% done here is the upsample.
camMap        = reqMatrix(req, 'camMap');
lesion384Path = reqStr(req, 'lesion384Path');
roi384Path    = reqStr(req, 'roi384Path');
%
% The score travels WITH its chance level. lesionAttentionConsistency.m's own
% header is blunt about why: "a raw overlap fraction is not interpretable" --
% if lesions cover 70% of the retina, a heatmap of pure noise also scores 0.70.
% The number means something only against `chanceLevel` (the lesion area
% fraction), and `enrichment` is that ratio. Returning the score alone would
% hand the UI a figure it cannot colour honestly, which is the specific
% mistake that header warns against.
lesionAttention   = [];
lesionChanceLevel = [];
lesionEnrichment  = [];
lesionFlagged     = [];
if ~isempty(camMap) && isfile(lesion384Path) && isfile(roi384Path)
    lesionMask = imread(lesion384Path) > 127;
    roiMask    = imread(roi384Path) > 127;
    camFull    = imresize(camMap, size(lesionMask), 'bilinear');
    [lesionAttention, lesionDetail] = lesionAttentionConsistency(camFull, lesionMask, roiMask);
    % NaN is this function's "undefined", for an eye with no segmented lesions
    % and for a heatmap with no energy. Empty here so the Node side stores NULL
    % rather than a number, while `flagged` -- which is defined in both of those
    % cases -- still travels.
    if ~isfinite(lesionAttention), lesionAttention = []; end
    lesionChanceLevel = nanToEmpty(lesionDetail.chanceLevel);
    lesionEnrichment  = nanToEmpty(lesionDetail.enrichment);
    lesionFlagged     = logical(lesionDetail.flagged);
end

% ── Task 7.3: the evidence report ───────────────────────────────────────────
% With counts present this produces the lesion-level sentence; with none it
% says segmentation has not been run rather than inventing "0 microaneurysms",
% because zero-measured and not-measured are different clinical claims.
% ruleOpts is passed through so the report's own ruleEngineGrade call sees the
% same VB/IRMA/fovea inputs as the grade above -- otherwise the text could
% explain a different grade from the one recorded.
[evidenceText, ~, ~] = generateEvidenceReport(reqStr(req, 'caseId'), evidenceInputs, ...
                                              struct('ruleOpts', ruleOpts));

out = struct();
out.evidenceSummaryText = evidenceText;
% Task 4.6: recorded so a DICOM submission is traceable to the device and eye
% the camera itself reported, rather than only to what a worker typed.
out.sourceFormat     = imgMeta.format;
out.dicomDeviceModel = imgMeta.deviceModel;
out.imageLaterality  = imgMeta.laterality;
out.cameraFamily     = cameraFamily;
out.cameraMismatch   = ~isempty(cameraDetail) && cameraDetail.mismatch;
% WHETHER THE CROSS-CHECK COULD RUN AT ALL. classifyCameraFamily compares the
% detected family against the family the REPORTED device implies, and it can
% only do that when that device is in calibrationProfiles.json's
% deviceAssociations. When it is not -- an unrecognised dropdown value, or no
% device reported -- expectedFamily is '' and mismatch comes back false.
%
% That false is "not checked", NOT "the two agree", and the two are different
% claims: one says a camera was verified against its image, the other says
% nobody could look. Empty here makes cases.camera_mismatch NULL on the Node
% side instead of a fabricated agreement.
if ~isempty(cameraDetail)
    out.cameraExpectedFamily = cameraDetail.expectedFamily;
else
    out.cameraExpectedFamily = '';
end
out.ruleEngineGrade  = ruleGrade;
out.branchAgreement  = branchAgree;
out.nvSuspicionScore = nvScore;
out.ruleIsLowerBound = ruleIsLowerBound;
out.ruleMaxGrade     = ruleMaxGrade;
out.lesionAttentionConsistency = lesionAttention;
out.lesionAttentionChanceLevel = lesionChanceLevel;
out.lesionAttentionEnrichment  = lesionEnrichment;
out.lesionAttentionFlagged     = lesionFlagged;

% ── Triage urgency (grading/calculateUrgencyScore.m) ───────────────────────
% A QUEUE ORDERING HINT. The forest behind it is trained on SYNTHETIC data --
% read that file's header -- so the score orders a review queue and must never
% touch the referral decision, the conformal tier, or the patient SMS.
%
% SKIPPED ENTIRELY when the clinical inputs are not there. No imputation, no
% bucket midpoint substituted silently, and above all no 1: 1 is a legitimate
% low-urgency score, so a missing HbA1c becoming 1 would be indistinguishable
% from a real result and would be a fabricated clinical statement about a real
% patient. Absent fields leave out.urgencyScore empty, which the Node side
% stores as NULL meaning "not computed".
%
% Runs inside this existing per-case call rather than as a new MATLAB spawn;
% the forest is cached per session, so only the first case pays its ~0.25 s.
[clin, clinOk] = reqClinical(req);
if clinOk
    gradeForUrgency = branchAGrade;
    if isempty(gradeForUrgency), gradeForUrgency = ruleGrade; end
    if ~isempty(gradeForUrgency)
        try
            u = calculateUrgencyScore(gradeForUrgency, clin.patientAge, ...
                                      clin.yearsDiabetic, clin.hba1c);
            out.urgencyScore      = u.urgencyScore;
            out.urgencyFactor     = u.topRiskFactor;
            out.urgencyLimitation = u.limitation;
            % Exactly what went in, so the number can be explained later --
            % including which values were measured rather than assumed, which
            % the caller states and this passes through unchanged.
            out.urgencyInputs = struct( ...
                'drGrade',       gradeForUrgency, ...
                'patientAge',    clin.patientAge, ...
                'yearsDiabetic', clin.yearsDiabetic, ...
                'hba1c',         clin.hba1c, ...
                'provenance',    clin.provenance, ...
                'gradeSource',   ternaryStr(~isempty(branchAGrade), 'branchA', 'ruleEngine'), ...
                'model',         u.model);
        catch ME
            % A scoring failure must not fail the case: the grade is already
            % computed and is the clinical output. Reported, not swallowed.
            out.urgencyError = ME.message;
        end
    end
end
end

function s = ternaryStr(cond, a, b)
if cond, s = a; else, s = b; end
end

% ── Reading the request ─────────────────────────────────────────────────────
% jsondecode maps JSON null to [], so "absent" and "explicitly null" arrive the
% same way and every reader below treats both as "not available". Each one
% VALIDATES rather than trusting the caller: this function is also reachable
% from the MATLAB prompt and from the session, where the JSON may not have come
% through buildCasePipelineInput's checks.

function s = reqStr(req, name)
s = '';
if isfield(req, name)
    v = req.(name);
    if ischar(v) || isstring(v)
        s = char(v);
    end
end
end

function v = reqScalar(req, name)
v = [];
if isfield(req, name)
    raw = req.(name);
    if isnumeric(raw) && isscalar(raw) && isfinite(raw)
        v = double(raw);
    end
end
end

function v = reqRow(req, name, n)
% An n-element numeric row, or [] when absent or the wrong shape. jsondecode
% gives a COLUMN for a JSON array; the consumers here are written for rows.
v = [];
if isfield(req, name)
    raw = req.(name);
    if isnumeric(raw) && numel(raw) == n && all(isfinite(raw(:)))
        v = double(reshape(raw, 1, n));
    end
end
end

function m = reqMatrix(req, name)
% [] rather than zeros(): an all-zero Grad-CAM is a real and meaningful state
% (no positive evidence survived the ReLU), so it must not share a value with
% "no heatmap was produced".
m = [];
if isfield(req, name)
    raw = req.(name);
    if isnumeric(raw) && ~isempty(raw) && ismatrix(raw) && all(isfinite(raw(:)))
        m = double(raw);
    end
end
end

function opts = reqRuleOpts(req)
% §H/§I. A field is included ONLY when it is present and well-formed, because
% to ruleEngineGrade a supplied array -- even an all-false one -- means that
% criterion WAS assessed and drops the "not assessed" caveat from the evidence.
opts = struct();
if ~isfield(req, 'ruleOpts') || ~isstruct(req.ruleOpts)
    return;
end
r = req.ruleOpts;
for name = {'venousBeadingQuadrants', 'irmaQuadrants'}
    key = name{1};
    if isfield(r, key)
        v = r.(key);
        if (islogical(v) || isnumeric(v)) && numel(v) == 4
            opts.(key) = logical(reshape(v, 1, 4));
        end
    end
end
if isfield(r, 'foveaUnreliable') && isequal(r.foveaUnreliable, true)
    opts.foveaUnreliable = true;
end

% ── THRESHOLDS, WHICH TRAVEL WITH THE COUNTS ───────────────────────────────
% This whitelist used to stop at foveaUnreliable, so when the orchestrator
% began attaching the red-lesion model's own thresholds (caseRuleOpts ->
% models/rule_thresholds_by_red_version.json) they were dropped HERE without
% a word. The JS fallback passes ruleOpts straight through, so the two
% engines would have graded the same image on different thresholds -- and
% with RED_LESION_MODEL_VERSION=v2 the difference is referable specificity
% 0.872 vs 0.231, not a rounding detail.
%
% Validated rather than trusted: a malformed value is IGNORED, leaving
% ruleEngineGrade on its documented defaults, because a threshold quietly
% coerced from nonsense is worse than one that was never supplied.
for name = {'redFloor', 'grade3QuadMin', 'moderateRedCount', 'brightFloor'}
    key = name{1};
    if ~isfield(r, key), continue; end
    v = r.(key);
    if isnumeric(v) && isscalar(v) && isfinite(v) && v >= 0 && mod(v, 1) == 0
        opts.(key) = double(v);
    end
end
end

function [clin, ok] = reqClinical(req)
% The clinical inputs the urgency score needs, or ok = false.
%
% ── THE RULE: ALL OR NOTHING ───────────────────────────────────────────────
% calculateUrgencyScore refuses impossible inputs itself, but it cannot know
% that a value was invented to satisfy it. So the decision is made here, once:
% unless age, yearsDiabetic AND hba1c are all present and in range, there is
% no score. Two of three is not "mostly enough" -- the missing one is exactly
% the input whose absence the score would be hiding.
%
% provenance travels with the values and is NOT interpreted here. The Node
% side says whether each number is a measured lab value or a bucket midpoint,
% because only it knows where the questionnaire got it; this passes that
% statement through to urgency_inputs unchanged so the case detail can show
% "HbA1c 9.5% (assumed from 'poor')" rather than implying a test happened.
clin = struct(); ok = false;
if ~isfield(req, 'clinical') || ~isstruct(req.clinical) || isempty(req.clinical)
    return;
end
c = req.clinical;

age   = numOrEmpty(c, 'patientAge');
years = numOrEmpty(c, 'yearsDiabetic');
hba1c = numOrEmpty(c, 'hba1c');
if isempty(age) || isempty(years) || isempty(hba1c)
    return;
end

% Ranges mirror calculateUrgencyScore's own guards, checked here so an
% out-of-range value is "no score" rather than an error that fails the case.
if age < 1 || age > 120 || years < 0 || years > 80 || hba1c < 4 || hba1c > 20
    return;
end

clin.patientAge    = age;
clin.yearsDiabetic = years;
clin.hba1c         = hba1c;
clin.provenance    = 'not stated';
if isfield(c, 'provenance') && (ischar(c.provenance) || isstring(c.provenance))
    clin.provenance = char(c.provenance);
elseif isfield(c, 'provenance') && isstruct(c.provenance)
    clin.provenance = c.provenance;
end
ok = true;
end

function v = numOrEmpty(s, name)
v = [];
if ~isfield(s, name), return; end
x = s.(name);
if isnumeric(x) && isscalar(x) && isfinite(x), v = double(x); end
end

function v = nanToEmpty(x)
% A NaN from lesionAttentionConsistency means UNDEFINED, not zero: an eye with
% no segmented lesions gives attention nothing to agree with. Empty here so the
% Node side writes NULL, which is the same distinction the rest of this
% pipeline keeps between "not measured" and "measured as zero".
v = [];
if isnumeric(x) && isscalar(x) && isfinite(x), v = double(x); end
end
