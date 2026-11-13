// Thin JSON client with Hungarian error messages.
export async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  } catch {
    const e = new Error('A szerver nem érhető el. Fut még az alkalmazás? (npm start)'); e.network = true; throw e;
  }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) { const e = new Error(data?.error || `Hiba történt (HTTP ${res.status}).`); e.status = res.status; throw e; }
  return data;
}
