(function () {
  const cfg = window.MERIT_CONFIG || {};
  const apiBaseUrl = String(cfg.apiBaseUrl || '').replace(/\/$/, '');
  const defaultFormId = cfg.defaultFormId || 'ican-registration';
  const TOKEN_KEY = 'met_admin_token';

  function endpoint(path) {
    return `${apiBaseUrl}${path}`;
  }

  function getToken() {
    return sessionStorage.getItem(TOKEN_KEY) || '';
  }

  async function request(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    if (options.auth !== false) {
      const token = getToken();
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    const response = await fetch(endpoint(path), { ...options, headers });
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const error = new Error(data?.error || `Request failed with HTTP ${response.status}`);
      error.status = response.status;
      // An authenticated request rejected with 401 means the session has expired
      // (or was revoked). Clear the stale token and notify listeners so the UI can
      // log the user out and prompt for re-authentication.
      if (response.status === 401 && options.auth !== false && getToken()) {
        sessionStorage.removeItem(TOKEN_KEY);
        window.dispatchEvent(new CustomEvent('met:session-expired'));
      }
      throw error;
    }
    return data;
  }

  window.__metApi = {
    defaultFormId,
    getToken,
    isAuthenticated() {
      return Boolean(getToken());
    },
    async login(password) {
      const data = await request('/api/admin/login', {
        method: 'POST',
        auth: false,
        body: JSON.stringify({ password }),
      });
      sessionStorage.setItem(TOKEN_KEY, data.token);
      return data;
    },
    async logout() {
      try { await request('/api/admin/logout', { method: 'POST' }); } catch (_) {}
      sessionStorage.removeItem(TOKEN_KEY);
    },
    changePassword(currentPassword, newPassword) {
      return request('/api/admin/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword }),
      });
    },
    publicConfig(formId = defaultFormId) {
      return request(`/api/forms/${encodeURIComponent(formId)}/config`, { auth: false });
    },
    submitRegistration(payload, formId = defaultFormId) {
      return request(`/api/forms/${encodeURIComponent(formId)}/submissions`, {
        method: 'POST',
        auth: false,
        body: JSON.stringify(payload),
      });
    },
    adminSettings(formId = defaultFormId) {
      return request(`/api/admin/forms/${encodeURIComponent(formId)}/settings`);
    },
    saveAdminSettings(payload, formId = defaultFormId) {
      return request(`/api/admin/forms/${encodeURIComponent(formId)}/settings`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
    },
    adminSubmissions(formId = defaultFormId) {
      return request(`/api/admin/forms/${encodeURIComponent(formId)}/submissions`);
    },
  };
})();
