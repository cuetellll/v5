class PulseAPI {
  constructor() {
    this.bus = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('pulsecord_realtime_bus') : null;
    this.listeners = new Set();
    this.socket = null;
    this.joinedChannelId = null;
    if (this.bus) this.bus.onmessage = (event) => this.listeners.forEach((cb) => { try { cb(event.data); } catch (err) { console.error('Realtime listener error:', err); } });
  }

  token() { return localStorage.getItem('pulsecord_access_token') || ''; }
  headers(extra = {}) {
    const headers = new Headers(extra);
    const token = this.token();
    if (token) headers.set('Authorization', `Bearer ${token}`);
    return headers;
  }
  async request(url, options = {}) {
    const response = await fetch(url, { ...options, headers: this.headers(options.headers) });
    if (response.status === 401 && !url.startsWith('/auth/login') && !url.startsWith('/auth/register')) {
      localStorage.removeItem('pulsecord_access_token');
      window.dispatchEvent(new CustomEvent('pulsecord:auth-expired'));
    }
    if (!response.ok) {
      let message = `Request failed with status ${response.status}`;
      let body = {};
      try { const parsed = await response.json(); if (parsed && typeof parsed === 'object') body = parsed; message = body.error || body.message || message; } catch (_) { /* non-JSON response */ }
      const error = new Error(message);
      error.status = response.status;
      if (typeof body.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(body.code)) error.code = body.code;
      if (typeof body.errorId === 'string' && /^[a-f0-9-]{16,64}$/i.test(body.errorId)) error.errorId = body.errorId;
      if (Array.isArray(body.missingVariables)) error.missingVariables = body.missingVariables.filter((name) => ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'].includes(name));
      throw error;
    }
    if (response.status === 204) return null;
    return response.json();
  }
  async login(email, password) {
    const result = await this.request('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    localStorage.setItem('pulsecord_access_token', result.accessToken);
    return result.user;
  }
  async register(data) {
    const result = await this.request('/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    localStorage.setItem('pulsecord_access_token', result.accessToken);
    return result.user;
  }
  async me() { return (await this.request('/auth/me')).user; }
  logout() {
    localStorage.removeItem('pulsecord_access_token');
    if (this.socket) { this.socket.disconnect(); this.socket = null; }
    this.joinedChannelId = null;
  }
  connectRealtime() {
    if (this.socket || typeof window.io !== 'function' || !this.token()) return this.socket;
    this.socket = window.io({ auth: { token: this.token() }, reconnection: true, reconnectionAttempts: Infinity, reconnectionDelayMax: 10000 });
    this.socket.on('connect', () => {
      if (this.joinedChannelId) this.socket.emit('channel:join', this.joinedChannelId);
      this.emitEvent('socket_connected', {});
    });
    this.socket.on('connect_error', (err) => {
      console.warn('Realtime connection error:', err.message);
      if (/expired|invalid token|authentication/i.test(err.message)) window.dispatchEvent(new CustomEvent('pulsecord:auth-expired'));
    });
    this.socket.on('message:new', (message) => this.emitEvent('message_new', message));
    this.socket.on('message:updated', (message) => this.emitEvent('message_updated', message));
    this.socket.on('message:deleted', (message) => this.emitEvent('message_deleted', message));
    this.socket.on('voice:updated', (session) => this.emitEvent('voice_updated', session));
    this.socket.on('direct_message:new', (message) => this.emitEvent('direct_message_new', message));
    this.socket.on('direct_message:updated', (message) => this.emitEvent('direct_message_updated', message));
    this.socket.on('direct_message:deleted', (message) => this.emitEvent('direct_message_deleted', message));
    this.socket.on('server:membership_revoked', (membership) => this.emitEvent('server_membership_revoked', membership));
    this.socket.on('server:permissions_changed', (membership) => this.emitEvent('server_permissions_changed', membership));
    return this.socket;
  }
  joinChannel(channelId) {
    if (this.joinedChannelId && this.joinedChannelId !== channelId && this.socket?.connected) this.socket.emit('channel:leave', this.joinedChannelId);
    this.joinedChannelId = channelId || null;
    if (this.socket?.connected && channelId) this.socket.emit('channel:join', channelId, (result) => { if (result?.error) console.warn('Channel join rejected:', result.error); });
  }
  onEvent(callback) { this.listeners.add(callback); return () => this.listeners.delete(callback); }
  emitEvent(type, payload) {
    const packet = { type, payload, ts: Date.now() };
    if (this.bus) this.bus.postMessage(packet);
    this.listeners.forEach((cb) => { try { cb(packet); } catch (err) { console.error('Realtime listener error:', err); } });
  }
  async list(table, { page = 1, limit = 100, search = '', sort = '' } = {}) {
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (search) params.set('search', search);
    if (sort) params.set('sort', sort);
    const json = await this.request(`/tables/${encodeURIComponent(table)}?${params}`);
    return Array.isArray(json.data) ? json.data : [];
  }
  get(table, id) { return this.request(`/tables/${encodeURIComponent(table)}/${encodeURIComponent(id)}`); }
  async create(table, record) {
    const created = await this.request(`/tables/${encodeURIComponent(table)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(record) });
    this.emitEvent('table_mutated', { table, action: 'create', record: created });
    return created;
  }
  async patch(table, id, partial) {
    const updated = await this.request(`/tables/${encodeURIComponent(table)}/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(partial) });
    this.emitEvent('table_mutated', { table, action: 'patch', record: updated });
    return updated;
  }
  async remove(table, id) {
    await this.request(`/tables/${encodeURIComponent(table)}/${encodeURIComponent(id)}`, { method: 'DELETE' });
    this.emitEvent('table_mutated', { table, action: 'delete', id });
    return true;
  }
  async uploadAttachment(file) {
    const error = new Error('Attachment storage is not configured on this deployment; the file was not uploaded.');
    error.status = 501;
    throw error;
  }
}
window.pulseAPI = new PulseAPI();
