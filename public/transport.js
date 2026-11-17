// Screen-independent Windows HTTP adapter. A future native/sync adapter must
// provide the same request(path, data) boundary with its own authentication.
export function createHttpTransport({ fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  async function request(path, data) {
    // Relative API paths only: this adapter must never forward cookies elsewhere.
    if (typeof path !== 'string' || !/^[a-z][a-z0-9/-]*(?:\?[^#]*)?$/.test(path))
      throw new Error('APIの接続先を確認してください。');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const timeoutError = () => new Error('サーバーの応答に時間がかかっています。接続を確認し、もう一度お試しください。');
    try {
      let response;
      try {
        response = await fetchImpl(`/api/${path}`, {
          credentials: 'same-origin',
          keepalive: path === 'rebooking/prompt' && data?.decision === 'later',
          signal: controller.signal,
          ...(data === undefined ? { cache: 'no-store' } : {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
          }),
        });
      } catch {
        if (controller.signal.aborted) throw timeoutError();
        throw new Error('サーバーに接続できません。接続を確認してください。');
      }
      let result;
      try { result = await response.json(); }
      catch {
        if (controller.signal.aborted) throw timeoutError();
        throw Object.assign(new Error('サーバーの応答を読み込めませんでした。接続を確認して、もう一度お試しください。'), { status: response.status });
      }
      if (!response.ok) throw Object.assign(new Error(typeof result?.error === 'string' ? result.error : '読み込みに失敗しました。'), { status: response.status });
      return result;
    } finally { clearTimeout(timer); }
  }
  async function discover() {
    let connection;
    try { connection = await request('connection'); }
    catch (error) {
      // v2 servers have no discovery route; authentication failures stay errors.
      if (error.status === 404) return { product: 'bathjun', apiVersion: 1, householdId: null, mode: 'legacy-windows', capabilities: [] };
      throw error;
    }
    if (connection?.product !== 'bathjun' || connection.apiVersion !== 1 ||
        typeof connection.householdId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(connection.householdId) ||
        !Array.isArray(connection.capabilities) || !connection.capabilities.every(value => typeof value === 'string'))
      throw new Error('この接続先のAPIには対応していません。アプリとサーバーのバージョンを確認してください。');
    return connection;
  }
  return { request, discover };
}
