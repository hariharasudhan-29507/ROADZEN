(function () {
  'use strict';

  if (document.body.dataset.page !== 'auth') return;

  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i;
  const message = document.getElementById('auth-message');
  const sessionDetails = document.getElementById('session-details');
  const logoutButton = document.getElementById('logout-btn');

  function setMessage(text, isError = false) {
    if (!message) return;
    message.textContent = text;
    message.classList.toggle('error', isError);
  }

  function renderSession(authState) {
    if (!sessionDetails) return;
    if (!authState.enabled) {
      sessionDetails.innerHTML = `
        <div class="factor-row">
          <div>
            <strong>Authentication not configured</strong>
            <div class="small-copy">Set Supabase environment variables before using login.</div>
          </div>
        </div>
      `;
      logoutButton?.classList.add('is-hidden');
      return;
    }

    if (authState.user) {
      sessionDetails.innerHTML = `
        <div class="factor-row">
          <div>
            <strong>Signed in</strong>
            <div class="small-copy">${RoadZen.escapeHtml(authState.user.email || 'Active RoadZen account')}</div>
          </div>
          <span class="risk-chip">Verified</span>
        </div>
      `;
      logoutButton?.classList.remove('is-hidden');
      return;
    }

    sessionDetails.innerHTML = `
      <div class="factor-row">
        <div>
          <strong>Not signed in</strong>
          <div class="small-copy">Login is required for complaint posting and photo uploads.</div>
        </div>
      </div>
    `;
    logoutButton?.classList.add('is-hidden');
  }

  window.RoadZenAuth?.subscribe(renderSession);

  document.getElementById('google-login')?.addEventListener('click', async () => {
    setMessage('Opening Google sign-in...');
    try {
      const result = await window.RoadZenAuth.signInWithGoogle();
      if (result.error) throw result.error;
    } catch (error) {
      setMessage(error.message || 'Google sign-in could not start.', true);
    }
  });

  document.getElementById('otp-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = document.getElementById('auth-email')?.value.trim();
    if (!emailPattern.test(email || '')) {
      setMessage('Enter a valid email address.', true);
      return;
    }
    setMessage('Sending secure OTP email...');
    try {
      const result = await window.RoadZenAuth.signInWithOtp(email);
      if (result.error) throw result.error;
      setMessage('Check your inbox for the RoadZen sign-in link or OTP.');
    } catch (error) {
      setMessage(error.message || 'OTP email could not be sent.', true);
    }
  });

  logoutButton?.addEventListener('click', async () => {
    await window.RoadZenAuth.signOut();
    setMessage('Signed out.');
  });
})();
