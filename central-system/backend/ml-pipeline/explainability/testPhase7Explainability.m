function testPhase7Explainability()
% TESTPHASE7EXPLAINABILITY  Unit tests for Tasks 7.1 and 7.3.
%
%   Run: matlab -batch "testPhase7Explainability"
%
%   Everything here is checked against values worked out by hand from
%   synthetic masks and counts, not against whatever the code produced on a
%   first run. Where a number is asserted, the arithmetic that produces it is
%   written into the comment above it.
%
%   Neither task's real inputs exist yet: lesion segmentation (Tasks 4.2/4.3)
%   is not built and Branch A is an untrained stub. What is verified here is
%   that the maths, the quadrant convention and the report templating are
%   correct, so that they are right on the day real masks arrive.

thisDir = fileparts(mfilename('fullpath'));
addpath(thisDir);
addpath(fullfile(thisDir, '..', 'grading'));
addpath(fullfile(thisDir, '..', 'segmentation'));

fprintf('\n===== Phase 7: explainability safeguards =====\n');
n = 0; f = 0;
TOL = 1e-12;

% ═══ Quadrant convention (shared by 5.1 and 7.3) ═══════════════════════════
fprintf('\n--- fundusQuadrants: the convention both tasks depend on ---\n');

names = fundusQuadrants('names');
[n,f] = tbool(n, f, 'canonical order is ST, IT, SN, IN', ...
    isequal(names, {'superior-temporal','inferior-temporal','superior-nasal','inferior-nasal'}));

% Disc at (100,100), fovea at (200,100): temporal is +x, superior is -y.
disc = [100 100]; fovea = [200 100];
%   (150, 50): temporal (x>100) and above (y<100) -> superior-temporal = 1
%   (150,150): temporal, below                    -> inferior-temporal = 2
%   ( 50, 50): nasal,    above                    -> superior-nasal    = 3
%   ( 50,150): nasal,    below                    -> inferior-nasal    = 4
pts = [150 50; 150 150; 50 50; 50 150];
q = fundusQuadrants(pts, disc, fovea);
[n,f] = tbool(n, f, 'quadrants assigned correctly for a right-facing axis', ...
    isequal(q(:)', [1 2 3 4]), mat2str(q(:)'));

% THE LATERALITY TEST. Mirror the eye: fovea now to the LEFT of the disc.
% Temporal is "towards the fovea" in both eyes, so a point at (50,50) is now
% superior-TEMPORAL, where it was superior-nasal above. If this fails, the
% report names the wrong side of the retina on half of all patients.
foveaMirrored = [0 100];
qm = fundusQuadrants([50 50; 150 50], disc, foveaMirrored);
[n,f] = tbool(n, f, 'temporal follows the fovea when the eye is mirrored', ...
    isequal(qm(:)', [1 3]), mat2str(qm(:)'));
fprintf('    (no laterality field exists in the schema; temporal is derived\n');
fprintf('     from the disc-fovea axis, which is correct for both eyes)\n');

[n,f] = terr(n, f, 'refuses to guess quadrants without both landmarks', ...
    @() fundusQuadrants([50 50], disc, [NaN NaN]), 'missingLandmark');
[n,f] = terr(n, f, 'refuses a degenerate axis (disc == fovea)', ...
    @() fundusQuadrants([50 50], disc, disc), 'degenerateAxis');

% Every point lands in exactly one quadrant, including points on the axes --
% otherwise the quadrant counts would not sum to the lesion total and the
% report's own numbers would disagree with ruleEngineGrade's.
onAxis = [200 100; 100 40; 100 160; 40 100; 100 100];
qa = fundusQuadrants(onAxis, disc, fovea);
[n,f] = tbool(n, f, 'points exactly on an axis still get a quadrant', ...
    all(qa >= 1 & qa <= 4), mat2str(qa(:)'));

% ═══ Task 7.1a: lesion-attention consistency ═══════════════════════════════
fprintf('\n--- lesionAttentionConsistency ---\n');

% A 10x10 ROI (all 100 px). Lesions occupy a 2x5 block = 10 px -> chance 0.10.
roi = true(10, 10);
lesion = false(10, 10); lesion(1:2, 1:5) = true;

% Heatmap of all ones: energy is uniform, so the fraction on lesions equals
% the lesion area fraction exactly. 10/100 = 0.10, enrichment 1.00 = chance.
flat = ones(10, 10);
[s1, d1] = lesionAttentionConsistency(flat, lesion, roi);
[n,f] = tnum(n, f, 'a flat heatmap scores exactly the chance level', s1, 0.10, TOL);
[n,f] = tnum(n, f, 'chance level is the lesion area fraction', d1.chanceLevel, 0.10, TOL);
[n,f] = tnum(n, f, 'enrichment of a flat heatmap is exactly 1.0', d1.enrichment, 1.0, TOL);
[n,f] = tbool(n, f, 'and it is flagged (no better than chance)', d1.flagged == true);
fprintf('    a heatmap that carries no information scores 0.10 -- which is why\n');
fprintf('    the raw fraction is never reported without its chance level\n');

% All energy on the lesions: 1.0, enrichment 10x.
onLesion = zeros(10, 10); onLesion(lesion) = 5;
[s2, d2] = lesionAttentionConsistency(onLesion, lesion, roi);
[n,f] = tnum(n, f, 'attention entirely on lesions scores 1.0', s2, 1.0, TOL);
[n,f] = tnum(n, f, 'enrichment is 1.0/0.10 = 10x', d2.enrichment, 10.0, TOL);
[n,f] = tbool(n, f, 'and it is not flagged', d2.flagged == false);

% All energy off the lesions: 0.0. The model looked somewhere else entirely.
offLesion = zeros(10, 10); offLesion(8:10, :) = 3;
[s3, d3] = lesionAttentionConsistency(offLesion, lesion, roi);
[n,f] = tnum(n, f, 'attention entirely off the lesions scores 0.0', s3, 0.0, TOL);
[n,f] = tbool(n, f, 'flagged: enrichment 0 is below chance', d3.flagged == true);

% Half the energy on lesions: 0.5, enrichment 5x.
% 10 lesion px at weight 1 = 10; 10 non-lesion px at weight 1 = 10; 10/20 = 0.5
half = zeros(10, 10); half(lesion) = 1; half(5:6, 1:5) = 1;
[s4, ~] = lesionAttentionConsistency(half, lesion, roi);
[n,f] = tnum(n, f, 'half the energy on lesions scores exactly 0.5', s4, 0.5, TOL);

% ── The ROI must actually restrict the denominator ────────────────────────
% Same heatmap, but half the frame is outside the retina. Energy in the black
% surround must not count: including it would make a mediocre heatmap look
% focused, because those pixels can never hold a lesion.
smallRoi = false(10, 10); smallRoi(1:5, :) = true;    % 50 px, lesions still 10
spread = ones(10, 10);
[sRoi, dRoi] = lesionAttentionConsistency(spread, lesion, smallRoi);
[n,f] = tnum(n, f, 'ROI restricts the denominator (10/50, not 10/100)', sRoi, 0.20, TOL);
[n,f] = tnum(n, f, 'and the chance level rises with it', dRoi.chanceLevel, 0.20, TOL);

% ── Undefined stays undefined ─────────────────────────────────────────────
[sNo, dNo] = lesionAttentionConsistency(flat, false(10, 10), roi);
[n,f] = tbool(n, f, 'no lesions -> score is NaN, not 0', isnan(sNo));
[n,f] = tbool(n, f, 'and the note says UNDEFINED rather than reporting a figure', ...
    contains(dNo.note, 'UNDEFINED'));
fprintf('    (a grade-0 eye correctly has no lesions; scoring it 0 would read\n');
fprintf('     as "the model looked in the wrong place")\n');

[sFlat, dFlat] = lesionAttentionConsistency(zeros(10, 10), lesion, roi);
[n,f] = tbool(n, f, 'an all-zero heatmap gives NaN', isnan(sFlat));
[n,f] = tbool(n, f, 'but IS flagged -- Grad-CAM produced nothing to check', ...
    dFlat.flagged == true);

% Negative heatmap values are shifted, not clipped: a negative weight would
% subtract from the energy of the region it supposedly highlights.
withNeg = ones(10, 10) * -1; withNeg(lesion) = 1;
[sNeg, ~] = lesionAttentionConsistency(withNeg, lesion, roi);
[n,f] = tbool(n, f, 'negative heatmap values are handled without going negative', ...
    sNeg >= 0 && sNeg <= 1, sNeg);

[n,f] = terr(n, f, 'rejects mismatched sizes', ...
    @() lesionAttentionConsistency(ones(10,10), false(5,5), true(10,10)), 'sizeMismatch');
[n,f] = terr(n, f, 'rejects an empty ROI', ...
    @() lesionAttentionConsistency(flat, lesion, false(10,10)), 'emptyRoi');

% ═══ Task 7.1b: counterfactual occlusion ═══════════════════════════════════
fprintf('\n--- counterfactualOcclusionTest ---\n');

img = uint8(ones(60, 60, 3) * 120);
img(20:29, 20:29, :) = 40;                 % a dark "lesion"
mask = false(60, 60); mask(20:29, 20:29) = true;

% A stand-in classifier whose confidence in grade 2 depends ONLY on how dark
% the lesion box is. Occluding it must therefore reduce that confidence -- the
% behaviour a model that genuinely grades on lesions would show.
lesionDriven = @(x) probsFromDarkness(x, [20 29 20 29]);
r1 = counterfactualOcclusionTest([], img, mask, ...
    struct('classifyFn', lesionDriven, 'method', 'localmean'));
[n,f] = tbool(n, f, 'a lesion-driven model loses confidence when the lesion goes', ...
    r1.confidenceDrop > 0, r1.confidenceDrop);
[n,f] = tbool(n, f, 'and the test passes', r1.passed == true);
fprintf('    confidence %.4f -> %.4f (drop %.4f)\n', ...
    r1.baseConfidence, r1.occludedConfidenceForBaseGrade, r1.confidenceDrop);

% A classifier that ignores the image entirely: the confidence cannot move, so
% the test must FAIL. This is the finding the whole task exists to surface --
% the grade does not rest on the lesions, which no amount of looking at a
% heatmap would reveal.
constant = @(~) [0.05 0.05 0.8 0.05 0.05];
r2 = counterfactualOcclusionTest([], img, mask, ...
    struct('classifyFn', constant, 'method', 'localmean'));
[n,f] = tnum(n, f, 'a model that ignores the lesion shows zero drop', ...
    r2.confidenceDrop, 0, TOL);
[n,f] = tbool(n, f, 'and the test FAILS, as it must', r2.passed == false);
[n,f] = tbool(n, f, 'and the failure is explained in words', ...
    contains(r2.finding, 'did not reduce confidence'));

[n,f] = tbool(n, f, "method='black' carries a warning that its drop is not evidence", ...
    isfield(counterfactualOcclusionTest([], img, mask, ...
        struct('classifyFn', lesionDriven, 'method', 'black')), 'warning'));
fprintf('    (a black fill is out-of-distribution: the drop measures a reaction\n');
fprintf('     to the artefact, so that test would pass even for a broken model)\n');

[n,f] = terr(n, f, 'refuses a case with no lesions to occlude', ...
    @() counterfactualOcclusionTest([], img, false(60,60), ...
        struct('classifyFn', constant)), 'noLesions');
[n,f] = terr(n, f, 'rejects a classifier that does not return 5 scores', ...
    @() counterfactualOcclusionTest([], img, mask, ...
        struct('classifyFn', @(~) [0.5 0.5])), 'badOutput');

% ═══ Task 7.3: the evidence report ═════════════════════════════════════════
fprintf('\n--- generateEvidenceReport ---\n');

% The plan's target sentence. Counts: 3 ST + 3 IN red = 6 total, 0 bright.
% ruleEngineGrade: totalRed 6 > 5 with no bright -> grade 2, moderate NPDR.
inputs = struct( ...
    'redByQuadrant',    [3 0 0 3], ...
    'brightByQuadrant', [0 0 0 0], ...
    'nvSuspicionScore', 0.1, ...
    'redSubtypes', struct('microaneurysms', 4, 'dotHaemorrhages', 2));

[text1, path1, det1] = generateEvidenceReport('case-verify-1', inputs);
fprintf('    "%s"\n', text1);

[n,f] = tnum(n, f, 'grade comes from ruleEngineGrade (6 red, no bright -> 2)', ...
    det1.grade, 2, TOL);
[n,f] = tbool(n, f, 'names the quadrants that actually have lesions', ...
    contains(text1, 'superior-temporal: 3') && contains(text1, 'inferior-nasal: 3'));
[n,f] = tbool(n, f, 'omits the quadrants with none', ...
    ~contains(text1, 'inferior-temporal') && ~contains(text1, 'superior-nasal'));
[n,f] = tbool(n, f, 'reports the subtype counts', ...
    contains(text1, '4 microaneurysms') && contains(text1, '2 dot haemorrhages'));
[n,f] = tbool(n, f, 'states the criterion that fired, in Branch B words', ...
    contains(text1, 'Moderate NPDR'));
[n,f] = tbool(n, f, 'carries Branch B limitation (2 of 3 severe criteria undetectable)', ...
    contains(text1, 'venous beading') || contains(text1, 'IRMA'));
[n,f] = tbool(n, f, 'no annotated image when no image was supplied', ...
    isempty(path1) && contains(det1.annotationNote, 'no image supplied'));

% With an image but no lesion coordinates, still no overlay: an unannotated
% copy of the fundus photo would sit at reportPath looking like a deliverable
% and contain no evidence.
withImage = inputs; withImage.image = uint8(zeros(40, 40, 3));
[~, pathNoPts, detNoPts] = generateEvidenceReport('case-verify-1b', withImage);
[n,f] = tbool(n, f, 'no overlay without lesion coordinates either', ...
    isempty(pathNoPts) && contains(detNoPts.annotationNote, 'no lesion coordinates'));

% ── Every COUNT in the findings clause must be in the database ────────────
% Checked on the findings sentence alone, deliberately. The criterion sentence
% legitimately cites thresholds from the rule text ("6 red lesions (>5)"), and
% a 5 that comes from the ICDR rule is part of the criterion being quoted, not
% a measurement. Lumping the two together would either flag a legitimate
% threshold or force a whitelist so permissive it stops catching anything.
findingsClause = extractBefore([text1 '.'], '. ');
nums = cellfun(@str2double, regexp(findingsClause, '\d+', 'match'));
stored = [3 3 6 4 2];                     % quadrant counts, red total, subtypes
unexplained = setdiff(nums, stored);
[n,f] = tbool(n, f, 'every figure in the findings clause traces to a stored count', ...
    isempty(unexplained), mat2str(unexplained));

% And the criterion is Branch B's own words, not a restatement that could drift
% from the rule the system actually applied.
[n,f] = tbool(n, f, 'the criterion text is verbatim from ruleEngineGrade', ...
    contains(text1, det1.evidence.criterion), det1.evidence.criterion);

% ── Absent counts must not become zeros ───────────────────────────────────
[text2, path2, det2] = generateEvidenceReport('case-verify-2', struct());
[n,f] = tbool(n, f, 'no counts -> says segmentation has not been run', ...
    contains(text2, 'has not been run'));
[n,f] = tbool(n, f, 'and does NOT claim zero lesions', ...
    ~contains(text2, '0 microaneurysm') && ~contains(text2, 'No microaneurysms'));
[n,f] = tbool(n, f, 'and flags that the grade was not cross-checked', ...
    contains(text2, 'has not been cross-checked'));
[n,f] = tbool(n, f, 'countsAvailable is false', det2.countsAvailable == false);
[n,f] = tbool(n, f, 'no report path', isempty(path2));
fprintf('    (zero-measured and not-measured are different clinical claims)\n');

% A genuinely clean eye DOES say zero -- the distinction above is real, not a
% blanket refusal to ever report a negative finding.
[text3, ~, det3] = generateEvidenceReport('case-verify-3', struct( ...
    'redByQuadrant', [0 0 0 0], 'brightByQuadrant', [0 0 0 0], 'nvSuspicionScore', 0));
[n,f] = tnum(n, f, 'a measured-clean eye grades 0', det3.grade, 0, TOL);
[n,f] = tbool(n, f, 'and reports the negative finding explicitly', ...
    contains(text3, 'No microaneurysms'));

% ── Internal contradiction is refused ─────────────────────────────────────
bad = inputs; bad.redSubtypes = struct('microaneurysms', 99);
[n,f] = terr(n, f, 'refuses a report whose subtype and quadrant totals disagree', ...
    @() generateEvidenceReport('case-verify-4', bad), 'countMismatch');
fprintf('    (two numbers in one sentence that contradict each other would be\n');
fprintf('     worse than one number alone)\n');

% ── Reproducibility: templated means identical, every time ────────────────
t_a = generateEvidenceReport('case-verify-5', inputs);
t_b = generateEvidenceReport('case-verify-5', inputs);
[n,f] = tbool(n, f, 'the same case produces byte-identical text', strcmp(t_a, t_b));

% ── Severe NPDR names the 4-2-1 criterion ─────────────────────────────────
severe = struct('redByQuadrant', [25 30 22 40], 'brightByQuadrant', [5 0 0 0], ...
                'nvSuspicionScore', 0.2);
[text6, ~, det6] = generateEvidenceReport('case-verify-6', severe);
[n,f] = tnum(n, f, 'severe NPDR grades 3', det6.grade, 3, TOL);
[n,f] = tbool(n, f, 'and the text names ETDRS 4-2-1(a) explicitly', ...
    contains(text6, '4-2-1'));
fprintf('    "%s"\n', text6);

% ── NV suspicion must never read as confirmed neovascularization ──────────
nv = struct('redByQuadrant', [5 5 5 5], 'brightByQuadrant', [1 1 0 0], ...
            'nvSuspicionScore', 0.85);
[text7, ~, det7] = generateEvidenceReport('case-verify-7', nv);
% Grade 4 is CAPPED to 3 by the rule engine: its only path to 4 is the
% unvalidated NV suspicion heuristic, so the label is withheld and grade-4
% detection is delegated to Branch A, where a disagreement forces review.
% The criterion still fires and the report still carries it -- the next three
% checks are what make that a reported limitation rather than a silent drop.
[n,f] = tnum(n, f, 'high NV suspicion is CAPPED to 3, not graded 4', det7.grade, 3, TOL);
[n,f] = tbool(n, f, 'the text says "possible", not confirmed', ...
    contains(text7, 'possible'));
[n,f] = tbool(n, f, 'and carries the not-a-validated-detector caveat', ...
    contains(text7, 'NOT a validated'));
[n,f] = tbool(n, f, 'and states that the grade was capped, so the suspicion is not lost', ...
    contains(text7, 'CAPPED to 3'));
fprintf('    "%s"\n', text7);

% ═══ Result ════════════════════════════════════════════════════════════════
fprintf('\n===== %d checks, %d failed =====\n', n, f);
fprintf(['NOTE: these are unit tests on synthetic inputs. They verify the maths,\n' ...
         'the quadrant convention and the templating -- not any clinical output.\n' ...
         '(This note used to say lesion segmentation "is not built". It is: the\n' ...
         'segmenter writes red and bright masks per case, and Task 7.1 now scores\n' ...
         'against them end to end. The note outlived the fact.)\n']);
if f > 0
    error('testPhase7Explainability:failed', '%d check(s) failed.', f);
end
end

% ── Helpers ────────────────────────────────────────────────────────────────
function p = probsFromDarkness(img, box)
% Stand-in classifier: confidence in grade 2 rises the darker the lesion box
% is relative to mid-grey. A model that really grades on lesions behaves this
% way, so occluding the lesion must move it.
patch = double(img(box(1):box(2), box(3):box(4), 1));
darkness = max(0, (120 - mean(patch(:))) / 120);
p = [0.2 0.2 0.2 0.2 0.2];
p(3) = p(3) + darkness;
p = p / sum(p);
end

function [n, f] = tnum(n, f, label, actual, expected, tol)
n = n + 1;
if abs(actual - expected) <= tol
    fprintf('  PASS  %s\n', label);
else
    fprintf('  FAIL  %s  (expected %.10g, got %.10g)\n', label, expected, actual);
    f = f + 1;
end
end

function [n, f] = tbool(n, f, label, cond, detail)
n = n + 1;
if cond
    fprintf('  PASS  %s\n', label);
else
    fprintf('  FAIL  %s\n', label);
    if nargin > 4, fprintf('        %s\n', string(detail)); end
    f = f + 1;
end
end

function [n, f] = terr(n, f, label, fn, idFragment)
n = n + 1;
try
    fn();
    fprintf('  FAIL  %s  (no error raised)\n', label);
    f = f + 1;
catch err
    if contains(err.identifier, idFragment)
        fprintf('  PASS  %s\n', label);
    else
        fprintf('  FAIL  %s  (wrong error: %s)\n', label, err.identifier);
        f = f + 1;
    end
end
end
