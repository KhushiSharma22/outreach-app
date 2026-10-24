/* API client. Every request is same-origin; writes carry the CSRF header the server requires. */
(function (root) {
  class ApiError extends Error {
    constructor(status, body) {
      super(body?.error?.message || `Request failed (${status}).`);
      this.status = status; this.code = body?.error?.code; this.fields = body?.error?.fields; this.body = body?.error || {};
    }
  }
  async function req(method, path, body, opts = {}) {
    const headers = { 'x-requested-with': 'outbound' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (opts.idem) headers['idempotency-key'] = opts.idem;
    if (root.OUTBOUND_TOKEN) headers.authorization = 'Bearer ' + root.OUTBOUND_TOKEN;
    let res;
    try { res = await root.fetch((root.OUTBOUND_BASE || '') + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' }); }
    catch { throw new ApiError(0, { error: { code: 'network', message: 'Cannot reach the server. Check that it is running and try again.' } }); }
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(res.status, data);
    return data;
  }
  const key = () => (root.crypto?.randomUUID ? root.crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2));
  root.Api = { get: p => req('GET', p), post: (p, b = {}, o) => req('POST', p, b, o), patch: (p, b) => req('PATCH', p, b), del: p => req('DELETE', p), key, ApiError };
})(typeof window !== 'undefined' ? window : globalThis);
