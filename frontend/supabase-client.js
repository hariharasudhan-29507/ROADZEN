(function () {
  'use strict';

  const state = {
    ready: false,
    enabled: false,
    config: null,
    client: null,
    session: null,
    user: null,
  };

  const listeners = new Set();

  function notify() {
    listeners.forEach((listener) => listener({ ...state }));
  }

  async function init() {
    if (state.ready) return state;
    try {
      const response = await fetch('/api/auth/config');
      const config = await response.json();
      state.config = config;
      state.enabled = Boolean(config.enabled && window.supabase);
      if (state.enabled) {
        state.client = window.supabase.createClient(config.url, config.anon_key, {
          auth: {
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: true,
          },
        });
        const sessionResult = await state.client.auth.getSession();
        state.session = sessionResult.data.session;
        state.user = state.session?.user || null;
        state.client.auth.onAuthStateChange((_event, session) => {
          state.session = session;
          state.user = session?.user || null;
          notify();
        });
      }
    } catch (_) {
      state.enabled = false;
    }
    state.ready = true;
    notify();
    return state;
  }

  async function getSession() {
    await init();
    return state.session;
  }

  async function getToken() {
    const session = await getSession();
    return session?.access_token || '';
  }

  async function authHeaders() {
    const token = await getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  async function signInWithOtp(email) {
    await init();
    if (!state.client) throw new Error('Authentication is not configured.');
    return state.client.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/auth` },
    });
  }

  async function signInWithGoogle() {
    await init();
    if (!state.client) throw new Error('Authentication is not configured.');
    return state.client.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/auth` },
    });
  }

  async function signOut() {
    await init();
    if (state.client) await state.client.auth.signOut();
  }

  async function uploadReportPhoto(reportId, file) {
    await init();
    if (!state.client || !state.user) throw new Error('Sign in before uploading photos.');
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
    const safeName = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
    const path = `${state.user.id}/${reportId}/${safeName}`;
    const result = await state.client.storage
      .from(state.config.report_bucket)
      .upload(path, file, {
        upsert: false,
        contentType: file.type,
      });
    if (result.error) throw result.error;
    return path;
  }

  window.RoadZenAuth = {
    init,
    getSession,
    getToken,
    authHeaders,
    signInWithOtp,
    signInWithGoogle,
    signOut,
    uploadReportPhoto,
    subscribe(listener) {
      listeners.add(listener);
      if (state.ready) listener({ ...state });
      return () => listeners.delete(listener);
    },
    state,
  };

  init();
})();
