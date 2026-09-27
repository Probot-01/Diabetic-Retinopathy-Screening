import React, { useState, useEffect } from 'react';

export const CentralProfileDrawer = ({
  isOpen = false,
  onClose,
  role = 'ophthalmologist',
  userProfile,
  onUpdateProfile,
  onLogout,
  isEmbeddedPage = false,
  defaultView = 'profile'
}) => {
  const isOphth = role === 'ophthalmologist';

  // Views: 'profile' | 'edit' | 'password'
  const [view, setView] = useState(defaultView);
  const [saveToast, setSaveToast] = useState(null);

  // Form states initialized with userProfile
  const [formData, setFormData] = useState({
    name: userProfile?.fullName || userProfile?.email || 'Signed-in user',
    email: userProfile?.email || 'krrishgadekar@gmail.com',
    phone: userProfile?.phone || '+91 98230 44821',
    officerId: userProfile?.officerId || (isOphth ? 'MCI-MH-2018-09421' : 'DHW-MH-PUN-042'),
    location: userProfile?.district || userProfile?.location || (isOphth ? 'District Civil Hospital & Regional Tele-Ophthalmology Centre, Pune' : 'Pune District (Rural & Peri-Urban Zone)'),
    designation: userProfile?.designation || (isOphth ? 'Chief Retina Specialist / Lead Ophthalmologist' : 'District Health Worker'),
  });

  // Password fields
  const [currPassword, setCurrPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  // Keep synced with external userProfile changes
  useEffect(() => {
    if (userProfile) {
      setFormData({
        name: userProfile.fullName || userProfile.email || 'Signed-in user',
        email: userProfile.email || 'krrishgadekar@gmail.com',
        phone: userProfile.phone || '+91 98230 44821',
        officerId: userProfile.officerId || (isOphth ? 'MCI-MH-2018-09421' : 'DHW-MH-PUN-042'),
        location: userProfile.district || userProfile.location || (isOphth ? 'District Civil Hospital & Regional Tele-Ophthalmology Centre, Pune' : 'Pune District (Rural & Peri-Urban Zone)'),
        designation: userProfile.designation || (isOphth ? 'Chief Retina Specialist / Lead Ophthalmologist' : 'District Health Worker'),
      });
    }
  }, [userProfile, isOphth]);

  // Reset view when opened/closed
  useEffect(() => {
    if (isOpen) {
      setView(defaultView);
    }
  }, [isOpen, defaultView]);

  if (!isOpen && !isEmbeddedPage) return null;

  const showToast = (msg) => {
    setSaveToast(msg);
    setTimeout(() => {
      setSaveToast(null);
    }, 3200);
  };

  const handleSaveProfile = (e) => {
    e.preventDefault();
    if (onUpdateProfile) {
      onUpdateProfile({
        fullName: formData.name,
        email: formData.email,
        phone: formData.phone,
        officerId: formData.officerId,
        district: formData.location,
        location: formData.location,
        designation: formData.designation
      });
    }
    showToast('Profile updated successfully.');
    setView('profile');
  };

  const handlePasswordSubmit = (e) => {
    e.preventDefault();
    if (newPassword.length < 6) {
      showToast('Error: Password must be at least 6 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      showToast('Error: Passwords do not match.');
      return;
    }
    showToast('Security credentials updated successfully.');
    setCurrPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setView('profile');
  };

  const getInitials = (name) => {
    if (!name) return 'KG';
    const parts = name.replace(/^Dr\.\s*/i, '').trim().split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    return parts[0].substring(0, 2).toUpperCase();
  };

  const renderAvatarCircle = () => {
    if (isOphth) {
      return (
        <div className="retro-profile-avatar" title="Apex Retina Specialist">
          <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#8B1D1D" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z" />
            <circle cx="12" cy="12" r="3.2" stroke="#8B1D1D" strokeWidth="2" fill="#FBF8F1" />
            <circle cx="12" cy="12" r="1.2" fill="#8B1D1D" />
          </svg>
        </div>
      );
    }
    return (
      <div className="retro-profile-avatar">
        <span className="retro-avatar-text">{getInitials(formData.name)}</span>
      </div>
    );
  };

  const content = (
    <div className={`retro-profile-container ${isEmbeddedPage ? 'retro-profile-container--page' : ''}`}>
      {/* ── Top Header ────────────────────────────────────────── */}
      <div className="retro-profile-topbar">
        <div className="retro-profile-topbar__title">
          {view === 'profile' && (isOphth ? 'Clinical profile' : 'Officer profile')}
          {view === 'edit' && (isOphth ? 'Edit specialist details' : 'Edit worker details')}
          {view === 'password' && 'Change password'}
        </div>
        {view === 'profile' ? (
          !isEmbeddedPage && (
            <button
              type="button"
              className="retro-profile-topbar__btn"
              onClick={onClose}
            >
              Close
            </button>
          )
        ) : (
          <button
            type="button"
            className="retro-profile-topbar__btn"
            onClick={() => setView('profile')}
          >
            Back
          </button>
        )}
      </div>

      {/* ── Toast Alert ────────────────────────────────────────── */}
      {saveToast && (
        <div className="retro-profile-toast">
          {saveToast}
        </div>
      )}

      {/* ── Scrollable Body ───────────────────────────────────── */}
      <div className="retro-profile-body-wrap">
        <div className="retro-profile-body">
        {view === 'profile' ? (
          <>
            {/* 1. Header Card (Banner + Avatar + Name + Badges) */}
            <div className="retro-card retro-card--hero">
              <div className="retro-card__banner" />
              <div className="retro-card__hero-inner">
                {renderAvatarCircle()}

                <div className="retro-hero-name-row">
                  <span className="retro-hero-name">{formData.name}</span>
                  <span className="retro-duty-badge">
                    <span className="retro-duty-dot" />
                    {isOphth ? 'On call' : 'On duty'}
                  </span>
                </div>

                <div className="retro-hero-subtitle">
                  {isOphth
                    ? 'Chief Retina Specialist / Lead Ophthalmologist'
                    : 'District Health Worker'}
                </div>

                <div className="retro-badge-row">
                  <span className="retro-id-badge">{formData.officerId}</span>
                  <span className="retro-clearance-badge">
                    <span className="retro-badge-shield">🛡</span>
                    {isOphth ? 'Level 5 - Apex Diagnostic Lead' : 'Level 4 · District Chief'}
                  </span>
                </div>
              </div>
            </div>

            {/* 2. Stats Grid Card */}
            <div className="retro-card retro-card--stats">
              {isOphth ? (
                <>
                  <div className="retro-stat-col">
                    <div className="retro-stat-num">7</div>
                    <div className="retro-stat-lbl">Tele-retina<br />nodes</div>
                  </div>
                  <div className="retro-stat-col">
                    <div className="retro-stat-num">212</div>
                    <div className="retro-stat-lbl">Screenings<br />graded</div>
                  </div>
                  <div className="retro-stat-col">
                    <div className="retro-stat-num">9</div>
                    <div className="retro-stat-lbl">Referrals<br />pending</div>
                  </div>
                </>
              ) : (
                <>
                  <div className="retro-stat-col">
                    <div className="retro-stat-num">7</div>
                    <div className="retro-stat-lbl">PHCs</div>
                  </div>
                  <div className="retro-stat-col">
                    <div className="retro-stat-num">64</div>
                    <div className="retro-stat-lbl">Villages</div>
                  </div>
                  <div className="retro-stat-col">
                    <div className="retro-stat-num">18</div>
                    <div className="retro-stat-lbl">Reports this<br />month</div>
                  </div>
                </>
              )}
            </div>

            {/* 3. Base Hospital Card (Ophth only) */}
            {isOphth && (
              <div className="retro-card">
                <div className="retro-card-heading">Base hospital</div>
                <div className="retro-card-text">
                  {formData.location}
                </div>
              </div>
            )}

            {/* 4. Assigned PHCs / Connected Nodes Card */}
            <div className="retro-card">
              <div className="retro-card-heading">
                {isOphth ? 'Connected tele-retina nodes' : 'Assigned PHCs'}
              </div>
              {!isOphth && (
                <div className="retro-card-subtext">
                  Pune district, rural and peri-urban zone
                </div>
              )}
              <div className="retro-chip-grid">
                <span className="retro-chip">
                  <span className="retro-chip-dot retro-chip-dot--green" />
                  Kharadi
                </span>
                <span className="retro-chip">
                  <span className="retro-chip-dot retro-chip-dot--green" />
                  Wagholi
                </span>
                <span className="retro-chip">
                  <span className="retro-chip-dot retro-chip-dot--green" />
                  Hadapsar
                </span>
                <span className="retro-chip">
                  <span className="retro-chip-dot retro-chip-dot--amber" />
                  Lohegaon
                </span>
                <span className="retro-chip">
                  <span className="retro-chip-dot retro-chip-dot--green" />
                  Alandi
                </span>
                <span className="retro-chip">
                  <span className="retro-chip-dot retro-chip-dot--green" />
                  Saswad
                </span>
                <span className="retro-chip">
                  <span className="retro-chip-dot retro-chip-dot--green" />
                  Khed
                </span>
              </div>
              <div className="retro-footnote">
                {isOphth
                  ? 'Amber means grading is pending.'
                  : 'Amber means a report is pending.'}
              </div>
            </div>

            {/* 5. Specialty Focus Card (Ophth only) */}
            {isOphth && (
              <div className="retro-card">
                <div className="retro-card-heading">Specialty focus</div>
                <div className="retro-focus-list">
                  <div className="retro-focus-tag">Medical retina</div>
                  <div className="retro-focus-tag">Diabetic retinopathy (ICDR)</div>
                  <div className="retro-focus-tag">AI-assisted tele-grading</div>
                </div>
              </div>
            )}

            {/* 6. Contact Card */}
            <div className="retro-card">
              <div className="retro-card-heading">Contact</div>

              <div className="retro-contact-row">
                <div className="retro-contact-info">
                  <div className="retro-contact-lbl">Email</div>
                  <div className="retro-contact-val">{formData.email}</div>
                </div>
                <button
                  type="button"
                  className="retro-icon-box"
                  title="Copy / Send email"
                  onClick={() => {
                    navigator.clipboard?.writeText(formData.email);
                    showToast('Email copied to clipboard.');
                  }}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#1A1008" strokeWidth="2">
                    <rect x="2" y="4" width="20" height="16" rx="2" />
                    <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
                  </svg>
                </button>
              </div>

              <div className="retro-contact-divider" />

              <div className="retro-contact-row">
                <div className="retro-contact-info">
                  <div className="retro-contact-lbl">
                    {isOphth ? 'Direct line / clinic ext.' : 'Direct line'}
                  </div>
                  <div className="retro-contact-val">{formData.phone}</div>
                </div>
                <button
                  type="button"
                  className="retro-icon-box"
                  title="Call / Copy phone"
                  onClick={() => {
                    navigator.clipboard?.writeText(formData.phone);
                    showToast('Phone number copied to clipboard.');
                  }}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#1A1008" strokeWidth="2">
                    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
                  </svg>
                </button>
              </div>

              {!isOphth && (
                <div className="retro-login-callout">
                  Last login today, 9:12 AM from Pune
                </div>
              )}
            </div>

            {/* 7. Action Menu Card */}
            <div className="retro-card retro-card--menu">
              <button
                type="button"
                className="retro-menu-item"
                onClick={() => setView('edit')}
              >
                <span className="retro-menu-left">
                  <span className="retro-menu-icon">✎</span>
                  Edit profile
                </span>
                <span className="retro-menu-arrow">&gt;</span>
              </button>

              <div className="retro-menu-divider" />

              <button
                type="button"
                className="retro-menu-item"
                onClick={() => setView('password')}
              >
                <span className="retro-menu-left">
                  <span className="retro-menu-icon">🔒</span>
                  Change password
                </span>
                <span className="retro-menu-arrow">&gt;</span>
              </button>

              {/* Log out option is only shown for ophthalmologist — district worker uses the EXIT button in the top navbar */}
              {isOphth && (
                <>
                  <div className="retro-menu-divider" />
                  <button
                    type="button"
                    className="retro-menu-item retro-menu-item--logout"
                    onClick={onLogout}
                  >
                    <span className="retro-menu-left">
                      <span className="retro-menu-icon">↪</span>
                      Log out
                    </span>
                    <span className="retro-menu-arrow" style={{ color: '#8B1D1D' }}>›</span>
                  </button>
                </>
              )}
            </div>
          </>
        ) : view === 'edit' ? (
          /* ── Edit Details Form (Image 3 & 4) ─────────────────────── */
          <div className="retro-card retro-card--hero">
            <div className="retro-card__banner" />
            <div className="retro-card__hero-inner">
              {renderAvatarCircle()}

              <form onSubmit={handleSaveProfile} className="retro-edit-form">
                <div className="retro-form-field">
                  <label className="retro-field-label">Full name</label>
                  <input
                    type="text"
                    className="retro-field-input"
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    required
                  />
                </div>

                <div className="retro-form-field">
                  <label className="retro-field-label">Email</label>
                  <input
                    type="email"
                    className="retro-field-input"
                    value={formData.email}
                    onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                    required
                  />
                </div>

                <div className="retro-form-field">
                  <label className="retro-field-label">
                    {isOphth ? 'Direct line / clinic ext.' : 'Direct line'}
                  </label>
                  <input
                    type="text"
                    className="retro-field-input"
                    value={formData.phone}
                    onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                    required
                  />
                </div>

                <div className="retro-form-field">
                  <label className="retro-field-label">
                    {isOphth ? 'Medical registration' : 'Worker ID'}
                  </label>
                  <input
                    type="text"
                    className="retro-field-input"
                    value={formData.officerId}
                    onChange={(e) => setFormData({ ...formData, officerId: e.target.value })}
                    required
                  />
                </div>

                <div className="retro-form-field">
                  <label className="retro-field-label">
                    {isOphth ? 'Base hospital' : 'District region'}
                  </label>
                  <input
                    type="text"
                    className="retro-field-input"
                    value={formData.location}
                    onChange={(e) => setFormData({ ...formData, location: e.target.value })}
                    required
                  />
                </div>

                <div className="retro-btn-row">
                  <button type="submit" className="retro-btn retro-btn--save">
                    Save changes
                  </button>
                  <button
                    type="button"
                    className="retro-btn retro-btn--cancel"
                    onClick={() => setView('profile')}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          </div>
        ) : (
          /* ── Change Password Form ─────────────────────────────── */
          <div className="retro-card retro-card--hero">
            <div className="retro-card__banner" />
            <div className="retro-card__hero-inner">
              {renderAvatarCircle()}

              <form onSubmit={handlePasswordSubmit} className="retro-edit-form">
                <div className="retro-form-field">
                  <label className="retro-field-label">Current password</label>
                  <input
                    type="password"
                    className="retro-field-input"
                    placeholder="Enter current password"
                    value={currPassword}
                    onChange={(e) => setCurrPassword(e.target.value)}
                    required
                  />
                </div>

                <div className="retro-form-field">
                  <label className="retro-field-label">New password</label>
                  <input
                    type="password"
                    className="retro-field-input"
                    placeholder="Min. 6 characters"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    required
                  />
                </div>

                <div className="retro-form-field">
                  <label className="retro-field-label">Confirm new password</label>
                  <input
                    type="password"
                    className="retro-field-input"
                    placeholder="Repeat new password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                  />
                </div>

                <div className="retro-btn-row">
                  <button type="submit" className="retro-btn retro-btn--save">
                    Update password
                  </button>
                  <button
                    type="button"
                    className="retro-btn retro-btn--cancel"
                    onClick={() => setView('profile')}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
        </div>
      </div>
    </div>
  );

  if (isEmbeddedPage) {
    return content;
  }

  return (
    <div
      className="retro-drawer-overlay"
      onClick={() => {
        if (onClose) onClose();
      }}
    >
      <div className="retro-drawer-panel" onClick={(e) => e.stopPropagation()}>
        {content}
      </div>
    </div>
  );
};
