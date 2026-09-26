import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { localApi } from '../../api/localApiClient';
import { USE_MOCK_DATA } from '../../config';
import { RetinalWaveCanvas } from '../shared/RetinalWaveCanvas';
import { LoadError } from '../shared/LoadError';
import { saveQuestionnaire } from '../../api/patientSession';
import { BLOOD_PRESSURE } from '../../api/captureOptions';

// Mock mode opens the form pre-filled with a clearly fictional patient for
// rapid testing. Live mode opens it empty — and with consent NOT ticked: a
// technician must record consent for the real person in front of them.
const demo = (value, empty = '') => (USE_MOCK_DATA ? value : empty);

/* ── questionnaire options: exactly the API's values (api-contracts.md) ── */
// (The form used to offer "Low (Hypotension)", which the API does not accept.)
const BLOOD_PRESSURE_OPTIONS = BLOOD_PRESSURE.map((o) => ({ value: o.id, label: o.label }));

const EYE_SYMPTOMS = [
  { id: 'blurredVision',      label: 'BLURRED VISION' },
  { id: 'floaters',           label: 'FLOATERS' },
  { id: 'suddenVisionChange', label: 'SUDDEN VISION CHANGE' },
  { id: 'eyePain',            label: 'EYE PAIN' },
];

const INDIAN_STATES = [
  'Andhra Pradesh','Arunachal Pradesh','Assam','Bihar','Chhattisgarh',
  'Goa','Gujarat','Haryana','Himachal Pradesh','Jharkhand','Karnataka',
  'Kerala','Madhya Pradesh','Maharashtra','Manipur','Meghalaya','Mizoram',
  'Nagaland','Odisha','Punjab','Rajasthan','Sikkim','Tamil Nadu','Telangana',
  'Tripura','Uttar Pradesh','Uttarakhand','West Bengal',
  'Andaman & Nicobar Islands','Chandigarh','Dadra & Nagar Haveli','Daman & Diu',
  'Delhi','Jammu & Kashmir','Ladakh','Lakshadweep','Puducherry',
];

/* ── Top-level Helper Components (must be outside to preserve DOM input focus) ── */
const SectionHeader = ({ title, label }) => (
  <div className="reg-section-header">
    {label && <span className="reg-section-header__badge">{label}</span>}
    <h2 className="reg-section-header__title">{title}</h2>
    <div className="reg-section-header__line" />
  </div>
);

const Field = ({ label, required, children, span }) => (
  <div className={`reg-field${span ? ` reg-field--span-${span}` : ''}`}>
    <label className="reg-label">{required && <span className="reg-req">*</span>}{label}</label>
    {children}
  </div>
);

const ChipGroup = ({ options, value, onChange, multi = false }) => (
  <div className="reg-chip-group">
    {options.map(opt => {
      const isActive = multi ? value[opt.id] : value === (opt.id || opt.value);
      return (
        <button
          key={opt.id || opt.value}
          type="button"
          className={`reg-chip${isActive ? ' reg-chip--active' : ''}`}
          onClick={() => multi ? onChange(opt.id) : onChange(opt.id || opt.value)}
        >
          {isActive && multi && <span className="reg-chip__check">✓ </span>}
          {opt.label}
        </button>
      );
    })}
  </div>
);

export const PatientRegistrationForm = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [submitError, setSubmitError] = useState(null);

  /* ── patient-info (mock mode: prefilled fictional patient, see demo()) ── */
  const [patientType, setPatientType] = useState('new');
  const [abhaId, setAbhaId] = useState(demo('91827364501928'));
  const [visitNo, setVisitNo] = useState(demo('1'));
  const [title, setTitle] = useState(demo('Mrs', 'Mr'));
  const [firstName, setFirstName] = useState(demo('Sunita'));
  const [middleName, setMiddleName] = useState(demo('K.'));
  const [lastName, setLastName] = useState(demo('Devi'));
  const [gender, setGender] = useState(demo('female'));
  const [dob, setDob] = useState(demo('12/03/1972'));
  const [age, setAge] = useState(demo('54'));
  const [maritalStatus, setMaritalStatus] = useState(demo('married'));
  const [bloodGroup, setBloodGroup] = useState(demo('B+', 'Unknown'));

  /* ── address ──────────────────────────────────────────── */
  const [address, setAddress] = useState(demo('Plot No. 24, Near Gram Panchayat, Village Rampur'));
  const [state, setState] = useState(demo('Maharashtra'));
  const [pincode, setPincode] = useState(demo('413102'));
  const [district, setDistrict] = useState(demo('Solapur'));
  const [occupation, setOccupation] = useState(demo('homemaker'));
  const [contactNumber, setContactNumber] = useState(demo('+919876543210'));
  const [altPhone, setAltPhone] = useState(demo('+919811223344'));

  /* ── questionnaire ────────────────────────────────────── */
  // Live mode starts with NOTHING answered (null / ''): "no skip" means every
  // question needs an answer the technician gave. A pre-selected 'moderate',
  // 'normal' or 'not applicable' would be an answer nobody gave.
  const [knownDiabetic, setKnownDiabetic] = useState(demo(true, null));
  const [yearsSinceDx, setYearsSinceDx] = useState(demo('5to10', ''));
  const [glycemicControl, setGlycemicControl] = useState(demo('moderate', ''));
  const [bloodPressure, setBloodPressure] = useState(demo('high', ''));
  const [pregnancy, setPregnancy] = useState(demo('not_applicable', ''));
  const [eyeSymptoms, setEyeSymptoms] = useState({
    blurredVision: demo(true, false), floaters: false, suddenVisionChange: false, eyePain: false,
  });
  // Symptoms are yes/no each, so "none of these" must be tapped -- an untouched
  // symptom list is not the same as "the patient has no symptoms".
  const [noSymptoms, setNoSymptoms] = useState(false);

  /* ── consent ──────────────────────────────────────────── */
  const [consentObtained, setConsentObtained] = useState(demo(true, false));
  const [consentGivenAt, setConsentGivenAt] = useState(() => (USE_MOCK_DATA ? new Date().toISOString() : null));

  /* derived */
  const parsedAge = parseInt(age, 10);
  const couldBePregnant = !age || isNaN(parsedAge) || parsedAge < 55;
  const fullName = [firstName, middleName, lastName].filter(Boolean).join(' ');

  // Every question answered? (Years since diagnosis is only asked of known
  // diabetics; pregnancy only where it could apply.)
  const symptomsAnswered = noSymptoms || Object.values(eyeSymptoms).some(Boolean);
  const questionnaireMissing = [
    knownDiabetic === null && 'known diabetic?',
    knownDiabetic === true && !yearsSinceDx && 'years since diagnosis',
    !glycemicControl && 'glycemic control',
    !bloodPressure && 'blood pressure',
    couldBePregnant && !pregnancy && 'pregnancy',
    !symptomsAnswered && 'eye symptoms (or "none of these")',
  ].filter(Boolean);

  /* auto-compute age from DOB */
  useEffect(() => {
    if (!dob) return;
    const [d, m, y] = dob.split('/').map(Number);
    if (!y || y < 1900) return;
    const birth = new Date(y, (m || 1) - 1, d || 1);
    const diff = Date.now() - birth.getTime();
    const computed = Math.floor(diff / (1000 * 60 * 60 * 24 * 365.25));
    if (computed > 0 && computed < 120) setAge(String(computed));
  }, [dob]);

  const toggleSymptom = (id) => {
    setNoSymptoms(false);
    setEyeSymptoms(prev => ({ ...prev, [id]: !prev[id] }));
  };
  const chooseNoSymptoms = () => {
    setNoSymptoms(true);
    setEyeSymptoms({ blurredVision: false, floaters: false, suddenVisionChange: false, eyePain: false });
  };

  const handleConsentChange = (e) => {
    const checked = e.target.checked;
    setConsentObtained(checked);
    setConsentGivenAt(checked ? new Date().toISOString() : null);
  };

  const handleClearAll = () => {
    setPatientType('new'); setAbhaId(''); setVisitNo('');
    setTitle('Mr'); setFirstName(''); setMiddleName(''); setLastName('');
    setGender(''); setDob(''); setAge(''); setMaritalStatus(''); setBloodGroup('Unknown');
    setAddress(''); setState(''); setPincode(''); setDistrict('');
    setOccupation(''); setContactNumber(''); setAltPhone('');
    setKnownDiabetic(null); setYearsSinceDx(''); setGlycemicControl('');
    setBloodPressure(''); setPregnancy(''); setNoSymptoms(false);
    setEyeSymptoms({ blurredVision: false, floaters: false, suddenVisionChange: false, eyePain: false });
    setConsentObtained(false); setConsentGivenAt(null);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!consentObtained) {
      alert('Informed verbal consent is required before initiating screening.');
      return;
    }
    if (!USE_MOCK_DATA && questionnaireMissing.length) {
      setSubmitError({ message: 'Answer every question before capture: ' + questionnaireMissing.join(', ') + '.' });
      return;
    }
    setLoading(true);
    setSubmitError(null);
    try {
      const payload = {
        name: fullName || firstName,
        age,
        contactNumber,
        abhaId,
        visitNo,
        title,
        firstName, middleName, lastName,
        gender, dob, maritalStatus, bloodGroup,
        address, state, pincode, district, occupation, altPhone,
        questionnaire: {
          knownDiabetic,
          // The API has no "not diabetic" value for this question and requires
          // one of the four buckets. For a patient who is not a known diabetic
          // it is recorded as '< 1 yr' -- and the form says so on screen; it is
          // never quietly a leftover default.
          yearsSinceDiagnosis: knownDiabetic ? yearsSinceDx : 'lt1',
          glycemicControl, bloodPressure,
          // Not asked (and sent as null) where pregnancy cannot apply.
          pregnancy: couldBePregnant ? pregnancy : 'not_applicable',
          ...eyeSymptoms,
        },
        consentGivenAt: consentGivenAt || new Date().toISOString(),
      };
      const newPatient = await localApi.registerPatient(payload);
      // Kept PER PATIENT for the capture screen to attach to each capture.
      saveQuestionnaire(newPatient.patientId, payload.questionnaire);
      try {
        localStorage.setItem('netra_latest_patient', JSON.stringify({ ...newPatient, ...payload }));
        const existing = JSON.parse(localStorage.getItem('netra_registered_patients') || '[]');
        localStorage.setItem('netra_registered_patients', JSON.stringify([{ ...newPatient, ...payload }, ...existing]));
      } catch (err) { console.warn('Storage sync failed:', err); }
      const query = new URLSearchParams({
        patientId: newPatient.patientId,
        name: payload.name,
        age: payload.age || '',
        contact: payload.contactNumber || '',
      }).toString();
      navigate(`/capture?${query}`);
    } catch (err) {
      // Not registered: stay on the form with everything the technician typed.
      console.error(err);
      setSubmitError(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="reg-screen">
      <RetinalWaveCanvas />

      <form className="reg-form" onSubmit={handleSubmit} noValidate>

        {/* ── 1. PATIENT INFORMATION ─────────────────────── */}
        <SectionHeader title="PATIENT INFORMATION" label="01" />

        <div className="reg-grid">
          <Field label="PATIENT TYPE">
            <select className="select reg-select" value={patientType} onChange={e => setPatientType(e.target.value)}>
              <option value="new">New Patient</option>
              <option value="revisit">Revisit</option>
              <option value="referral">Referral</option>
            </select>
          </Field>

          <Field label="PATIENT ID">
            <input className="input" placeholder="auto-generated" readOnly />
          </Field>

          <Field label="ABHA ID (OPTIONAL)">
            <input className="input" placeholder="14-digit ABHA number" value={abhaId}
              onChange={e => setAbhaId(e.target.value)} maxLength={14} />
          </Field>

          <Field label="VISIT NO.">
            <input className="input" placeholder="e.g. 1" value={visitNo}
              onChange={e => setVisitNo(e.target.value)} />
          </Field>
        </div>

        <div className="reg-grid">
          <Field label="TITLE">
            <select className="select reg-select" value={title} onChange={e => setTitle(e.target.value)}>
              {['Mr', 'Mrs', 'Ms', 'Dr', 'Prof'].map(t => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </Field>

          <Field label="FIRST NAME" required>
            <input className="input" placeholder="e.g. Sunita" value={firstName}
              onChange={e => setFirstName(e.target.value)} required />
          </Field>

          <Field label="MIDDLE NAME">
            <input className="input" placeholder="Optional" value={middleName}
              onChange={e => setMiddleName(e.target.value)} />
          </Field>

          <Field label="LAST NAME" required>
            <input className="input" placeholder="e.g. Devi" value={lastName}
              onChange={e => setLastName(e.target.value)} required />
          </Field>
        </div>

        <div className="reg-grid">
          <Field label="GENDER" required>
            <select className="select reg-select" value={gender} onChange={e => setGender(e.target.value)} required>
              <option value="">Select</option>
              <option value="female">Female</option>
              <option value="male">Male</option>
              <option value="other">Other</option>
            </select>
          </Field>

          <Field label="DATE OF BIRTH" required>
            <input className="input" placeholder="DD/MM/YYYY" value={dob}
              onChange={e => setDob(e.target.value)} />
          </Field>

          <Field label="AGE" required>
            <input className="input" type="number" placeholder="e.g. 54" value={age}
              onChange={e => setAge(e.target.value)} min="0" max="120" required />
          </Field>

          <Field label="MARITAL STATUS">
            <select className="select reg-select" value={maritalStatus} onChange={e => setMaritalStatus(e.target.value)}>
              <option value="">Select</option>
              <option value="single">Single</option>
              <option value="married">Married</option>
              <option value="widowed">Widowed</option>
              <option value="divorced">Divorced</option>
            </select>
          </Field>

          <Field label="BLOOD GROUP">
            <select className="select reg-select" value={bloodGroup} onChange={e => setBloodGroup(e.target.value)}>
              {['Unknown','A+','A-','B+','B-','AB+','AB-','O+','O-'].map(bg => (
                <option key={bg} value={bg}>{bg}</option>
              ))}
            </select>
          </Field>
        </div>

        {/* ── 2. ADDRESS ───────────────────────────────────── */}
        <SectionHeader title="ADDRESS" label="02" />

        <div className="reg-grid">
          <Field label="ADDRESS" required span={2}>
            <textarea className="input reg-textarea" placeholder="Full address" value={address}
              onChange={e => setAddress(e.target.value)} required rows={3} />
          </Field>

          <Field label="STATE" required>
            <select className="select reg-select" value={state} onChange={e => setState(e.target.value)} required>
              <option value="">Select</option>
              {INDIAN_STATES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>

          <Field label="PINCODE">
            <input className="input" placeholder="6-digit PIN" value={pincode}
              onChange={e => setPincode(e.target.value)} maxLength={6} />
          </Field>
        </div>

        <div className="reg-grid">
          <Field label="DISTRICT" required>
            <input className="input" placeholder="e.g. Pune" value={district}
              onChange={e => setDistrict(e.target.value)} required />
          </Field>

          <Field label="OCCUPATION">
            <select className="select reg-select" value={occupation} onChange={e => setOccupation(e.target.value)}>
              <option value="">Select</option>
              <option value="farmer">Farmer</option>
              <option value="labourer">Daily Labourer</option>
              <option value="homemaker">Homemaker</option>
              <option value="govt_employee">Govt. Employee</option>
              <option value="business">Business</option>
              <option value="student">Student</option>
              <option value="other">Other</option>
            </select>
          </Field>

          <Field label="CONTACT NUMBER" required>
            <input className="input" type="tel" placeholder="+91..." value={contactNumber}
              onChange={e => setContactNumber(e.target.value)} required
              title="Required — only channel for delayed/offline result delivery" />
          </Field>

          <Field label="ALTERNATE PHONE">
            <input className="input" type="tel" placeholder="Optional" value={altPhone}
              onChange={e => setAltPhone(e.target.value)} />
          </Field>
        </div>

        {/* ── 3. CLINICAL SYMPTOM & RISK QUESTIONNAIRE ─────── */}
        <SectionHeader title="CLINICAL SYMPTOM & RISK QUESTIONNAIRE" label="03" />

        <div className="reg-questionnaire-card">

          {/* Known Diabetic -- an explicit YES / NO, not a toggle that starts on an answer */}
          <div className="reg-q-row">
            <span className="meta-label">KNOWN DIABETIC? <span className="reg-req">*</span></span>
            <div className="reg-chip-group">
              {[{ v: true, label: 'YES' }, { v: false, label: 'NO' }].map((o) => (
                <button key={o.label} type="button"
                  className={`reg-chip${knownDiabetic === o.v ? ' reg-chip--active' : ''}`}
                  onClick={() => setKnownDiabetic(o.v)}
                >{o.label}</button>
              ))}
            </div>
            {knownDiabetic === false && (
              <div className="t-mono" style={{ fontSize: 11, opacity: 0.8, marginTop: 6 }}>
                The record has no "not diabetic" value for years since diagnosis; it will be stored as "&lt; 1 yr".
              </div>
            )}
          </div>

          {/* Years Since Diagnosis (conditional) */}
          {knownDiabetic && (
            <div className="reg-q-row">
              <span className="meta-label">YEARS SINCE DIAGNOSIS <span className="reg-req">*</span></span>
              <div className="reg-chip-group">
                {[
                  { id: 'lt1',   label: '< 1 YR'    },
                  { id: '1to5',  label: '1–5 YRS'   },
                  { id: '5to10', label: '5–10 YRS'  },
                  { id: 'gt10',  label: '> 10 YRS'  },
                ].map(opt => (
                  <button key={opt.id} type="button"
                    className={`reg-chip${yearsSinceDx === opt.id ? ' reg-chip--active' : ''}`}
                    onClick={() => setYearsSinceDx(opt.id)}
                  >{opt.label}</button>
                ))}
              </div>
            </div>
          )}

          {/* Glycemic Control */}
          <div className="reg-q-row">
            <span className="meta-label">GLYCEMIC CONTROL (BLOOD SUGAR) <span className="reg-req">*</span></span>
            <div className="reg-chip-group">
              {[
                { id: 'good',     label: 'GOOD'     },
                { id: 'moderate', label: 'MODERATE' },
                { id: 'poor',     label: 'POOR'     },
              ].map(opt => (
                <button key={opt.id} type="button"
                  className={`reg-chip${glycemicControl === opt.id ? ' reg-chip--active' : ''}`}
                  onClick={() => setGlycemicControl(opt.id)}
                >{opt.label}</button>
              ))}
            </div>
          </div>

          {/* Blood Pressure */}
          <div className="reg-q-row">
            <span className="meta-label">BLOOD PRESSURE STATUS <span className="reg-req">*</span></span>
            <select className="select meta-select"
              value={bloodPressure}
              onChange={e => setBloodPressure(e.target.value)}>
              <option value="" disabled>SELECT…</option>
              {BLOOD_PRESSURE_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>

          {/* Pregnancy */}
          {couldBePregnant && (
            <div className="reg-q-row">
              <span className="meta-label">CURRENTLY PREGNANT? <span className="reg-req">*</span></span>
              <div className="reg-chip-group">
                {[
                  { id: 'yes',            label: 'YES' },
                  { id: 'no',             label: 'NO'  },
                  { id: 'not_applicable', label: 'N / A' },
                ].map(opt => (
                  <button key={opt.id} type="button"
                    className={`reg-chip${pregnancy === opt.id ? ' reg-chip--active' : ''}`}
                    onClick={() => setPregnancy(opt.id)}
                  >{opt.label}</button>
                ))}
              </div>
            </div>
          )}

          {/* Eye Symptoms */}
          <div className="reg-q-row">
            <span className="meta-label">CURRENT EYE SYMPTOMS (SELECT ALL THAT APPLY) <span className="reg-req">*</span></span>
            <div className="reg-chip-group reg-chip-group--grid">
              {EYE_SYMPTOMS.map(sym => (
                <button key={sym.id} type="button"
                  className={`reg-chip${eyeSymptoms[sym.id] ? ' reg-chip--active' : ''}`}
                  onClick={() => toggleSymptom(sym.id)}
                >
                  {eyeSymptoms[sym.id] && <span className="reg-chip__check">✓ </span>}
                  {sym.label}
                </button>
              ))}
              <button type="button"
                className={`reg-chip${noSymptoms ? ' reg-chip--active' : ''}`}
                onClick={chooseNoSymptoms}
              >
                {noSymptoms && <span className="reg-chip__check">✓ </span>}
                NONE OF THESE
              </button>
            </div>
          </div>
        </div>

        {/* ── 4. INFORMED VERBAL CONSENT ──────────────────── */}
        <div className="reg-consent-block">
          <label className="reg-consent-label">
            <input
              type="checkbox"
              className="reg-consent-checkbox"
              checked={consentObtained}
              onChange={handleConsentChange}
              required
            />
            <div className="reg-consent-text">
              <span className="reg-consent-title">INFORMED VERBAL CONSENT (DPDP ACT SEC 9.7)</span>
              <span className="reg-consent-body">
                I confirm that informed verbal consent has been obtained from the patient for retinal image
                capture, clinical risk assessment, and tele-ophthalmology review.
              </span>
            </div>
          </label>
        </div>

        {/* ── 5. FOOTER ACTIONS ───────────────────────────── */}
        {!USE_MOCK_DATA && questionnaireMissing.length > 0 && (
          <div className="t-mono" data-testid="questionnaire-missing"
            style={{ fontSize: 12, color: 'var(--c-crimson, #C42B2B)', margin: '8px 0' }}>
            Still to answer before capture: {questionnaireMissing.join(' · ')}
          </div>
        )}
        {submitError && <LoadError error={submitError} title="PATIENT NOT REGISTERED" compact />}
        <div className="reg-footer">
          <button type="button" className="btn btn--outline" onClick={handleClearAll}>
            <span>CLEAR ALL</span>
          </button>
          <button
            type="submit"
            className="btn btn--lg"
            disabled={loading || !consentObtained || !firstName || !contactNumber
              || (!USE_MOCK_DATA && questionnaireMissing.length > 0)}
            title={!USE_MOCK_DATA && questionnaireMissing.length
              ? 'Still to answer: ' + questionnaireMissing.join(', ') : undefined}
          >
            <span>{loading ? 'REGISTERING...' : 'INITIATE CAPTURE →'}</span>
          </button>
        </div>

      </form>
    </div>
  );
};
