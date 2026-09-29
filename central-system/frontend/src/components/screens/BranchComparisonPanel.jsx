import React from 'react';
import { drGradeLabels } from '../../api/mockData';

export const BranchComparisonPanel = ({ caseData }) => {
  const c = caseData;
  const isMismatch = c.branchAgreement === false;

  return (
    <div className={`branch-comparison ${isMismatch ? 'branch-comparison--mismatch' : ''}`} style={{ border: 'var(--border)' }}>
      <div style={{ padding: 'var(--sp-4) var(--sp-6)', borderBottom: 'var(--border)' }}>
        <h3 className="t-h3">GRADING COMPARISON</h3>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr' }}>
        {/* CNN Branch A */}
        <div className="branch-card" style={{ padding: 'var(--sp-6)', borderRight: 'var(--border)' }}>
          <span className="t-label" style={{ opacity: 0.5 }}>CNN BRANCH A</span>
          <div className="branch-card__grade" style={{ marginTop: 'var(--sp-3)' }}>
            <span className="t-display" style={{ fontSize: 'clamp(2rem, 4vw, 3.5rem)' }}>
              {c.drGradeCnn !== null ? c.drGradeCnn : '—'}
            </span>
          </div>
          <span className="t-mono" style={{ fontWeight: 700, marginTop: 'var(--sp-2)', display: 'block' }}>
            {c.drGradeCnn !== null ? drGradeLabels[c.drGradeCnn] : 'NOT YET AVAILABLE'}
          </span>
        </div>

        {/* Rule Engine Branch B */}
        <div className="branch-card" style={{ padding: 'var(--sp-6)' }}>
          <span className="t-label" style={{ opacity: 0.5 }}>RULE ENGINE B</span>
          <div className="branch-card__grade" style={{ marginTop: 'var(--sp-3)' }}>
            <span className="t-display" style={{ fontSize: 'clamp(2rem, 4vw, 3.5rem)' }}>
              {c.drGradeRuleEngine !== null ? c.drGradeRuleEngine : '—'}
            </span>
          </div>
          <span className="t-mono" style={{ fontWeight: 700, marginTop: 'var(--sp-2)', display: 'block' }}>
            {c.drGradeRuleEngine !== null ? drGradeLabels[c.drGradeRuleEngine] : 'NOT YET AVAILABLE'}
          </span>
        </div>
      </div>

      {/* Agreement Status */}
      <div className={`branch-agreement-bar ${isMismatch ? 'branch-agreement-bar--mismatch' : ''}`}>
        {c.branchAgreement === null && c.drGradeRuleEngine !== null && c.drGradeRuleEngine !== undefined ? (
          /* Branch B RAN -- its grade is on this very panel -- but agreement is
             undecidable, so this must not read "not available". The rule engine
             caps its output at RULE_MAX_GRADE (3), and a grade sitting on that
             cap means ">= 3, and I cannot tell which" rather than "= 3", so
             branchesAgree.m returns null rather than inventing a verdict. That
             is 106 of the graded cases in this database, every one of them
             cnn=3 / rule=3, and every one of them was being labelled
             single-branch mode next to a visible Branch B grade of 3.
             generateReport.m's PDF has always worded this correctly; this
             screen did not. */
          <span className="t-mono" style={{ fontWeight: 700 }}
            title={'The rule engine stops at grade 3, so a 3 from it means "grade 3 or worse". '
              + 'It cannot confirm or contradict a classifier grade of 3 or above, which is not '
              + 'the same as the branches disagreeing.'}>
            AGREEMENT NOT ESTABLISHED — RULE ENGINE IS AT ITS CEILING (GRADE {c.drGradeRuleEngine} MEANS &ldquo;OR WORSE&rdquo;)
          </span>
        ) : c.branchAgreement === null ? (
          <span className="t-mono" style={{ opacity: 0.3 }}>BRANCH B NOT YET AVAILABLE — SINGLE-BRANCH MODE</span>
        ) : c.branchAgreement ? (
          <span className="t-mono" style={{ color: 'var(--c-success)', fontWeight: 700 }}>
            ✓ BRANCHES AGREE — GRADE {c.drGradeCnn} CONFIRMED BY BOTH PIPELINES
          </span>
        ) : (
          <span className="t-mono" style={{ color: 'white', fontWeight: 700 }}>
            ⚠ BRANCHES DISAGREE — CNN: GRADE {c.drGradeCnn} vs RULE ENGINE: GRADE {c.drGradeRuleEngine} — MANDATORY MANUAL REVIEW REQUIRED
          </span>
        )}
      </div>
    </div>
  );
};
