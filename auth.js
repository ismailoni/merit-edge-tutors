(function () {
  const api = window.__metApi;
  if (!api) throw new Error('Admin API helper must be loaded before auth.js');

  const veil = document.createElement('style');
  veil.id = 'auth-veil';
  veil.textContent = 'body{visibility:hidden!important}';
  document.head.appendChild(veil);

  function revealPage() {
    document.getElementById('auth-veil')?.remove();
    document.getElementById('auth-overlay')?.remove();
    document.body.style.visibility = '';
  }

  function buildOverlay(options = {}) {
    const expired = Boolean(options.expired);
    // Avoid stacking multiple overlays (e.g. several API calls failing at once).
    if (document.getElementById('auth-overlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'auth-overlay';
    overlay.innerHTML = `
      <div class="auth-modal">
        <div class="auth-brand">Merit Edge Tutors</div>
        <h2 class="auth-title">Admin Access</h2>
        <p class="auth-sub">${expired ? 'Your session has expired. Please log in again to continue.' : 'Enter your password to continue.'}</p>
        <form id="auth-form" autocomplete="on" novalidate>
          <div class="auth-field">
            <svg class="auth-field-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
              <path d="M7 11V7a5 5 0 0110 0v4"/>
            </svg>
            <input type="password" id="auth-pw" class="auth-input" placeholder="Password" autocomplete="current-password" required />
            <button type="button" class="auth-pw-toggle" id="auth-pw-toggle" aria-label="Show/hide password">
             <svg id="auth-eye-show" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>
             <svg id="auth-eye-hide" hidden xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-.722-3.25"/><path d="M2 8a10.645 10.645 0 0 0 20 0"/><path d="m20 15-1.726-2.05"/><path d="m4 15 1.726-2.05"/><path d="m9 18 .722-3.25"/></svg>
            </button>
          </div>
          <p id="auth-error" class="auth-error" hidden>Incorrect password. Please try again.</p>
          <button type="submit" class="auth-btn" id="auth-submit"><span id="auth-btn-text">Login</span></button>
        </form>
      </div>`;

    document.body.prepend(overlay);
    document.getElementById('auth-veil')?.remove();
    document.body.style.visibility = 'visible';

    const pwInput = document.getElementById('auth-pw');
    const errMsg = document.getElementById('auth-error');
    const btnText = document.getElementById('auth-btn-text');
    const submit = document.getElementById('auth-submit');
    setTimeout(() => pwInput.focus(), 60);

    document.getElementById('auth-pw-toggle').addEventListener('click', () => {
      const hidden = pwInput.type === 'password';
      pwInput.type = hidden ? 'text' : 'password';
      document.getElementById('auth-eye-show').hidden = hidden;
      document.getElementById('auth-eye-hide').hidden = !hidden;
    });

    document.getElementById('auth-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      errMsg.hidden = true;
      submit.disabled = true;
      btnText.textContent = 'Logging in…';
      try {
        await api.login(pwInput.value);
        // After re-authenticating from an expired session the page already has
        // stale/failed data, so reload to refetch everything with the new token.
        if (expired) { location.reload(); return; }
        revealPage();
      } catch (_) {
        btnText.textContent = 'Login';
        errMsg.hidden = false;
        pwInput.value = '';
        pwInput.focus();
      } finally {
        submit.disabled = false;
      }
    });
  }

  window.__metAuth = {
    async logout() {
      await api.logout();
      location.reload();
    },
    async changePassword(currentPw, newPw) {
      try {
        await api.changePassword(currentPw, newPw);
        return true;
      } catch (_) {
        return false;
      }
    },
  };

    // If an authenticated API call detects the session has expired (401), the token
  // has already been cleared in api.js — prompt the user to log in again.
  window.addEventListener('met:session-expired', () => {
    if (document.body) buildOverlay({ expired: true });
    else document.addEventListener('DOMContentLoaded', () => buildOverlay({ expired: true }));
  });

  if (api.isAuthenticated()) {
    revealPage();
    return;
  }

  if (document.body) buildOverlay();
  else document.addEventListener('DOMContentLoaded', () => buildOverlay());
})();
