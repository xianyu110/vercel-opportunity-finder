const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");

function apiUrl(path) {
  return `${API_BASE_URL}${path}`;
}

async function readJson(response) {
  const payload = await response.json().catch(() => ({}));

  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }

  return payload;
}

function withParams(values) {
  const params = new URLSearchParams();
  Object.entries(values || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      params.set(key, String(value));
    }
  });
  return params;
}

/** Parallel multi-source discovery (preferred). */
export async function discoverAll({ suffix, limit, sources }) {
  return readJson(
    await fetch(apiUrl("/api/discover"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ suffix, limit, sources })
    })
  );
}

export async function analyzeUrls({
  urls,
  limit,
  source,
  mode = "smart",
  excludedHosts = [],
  suffix = "vercel.app",
  enrichMomentum = true,
  saveHistory = true
}) {
  return readJson(
    await fetch(apiUrl("/api/analyze"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        urls,
        limit,
        source,
        mode,
        excludedHosts,
        suffix,
        enrichMomentum,
        saveHistory
      })
    })
  );
}

export async function listHistory({ suffix, limit = 20 } = {}) {
  const params = withParams({ suffix, limit });
  return readJson(await fetch(apiUrl(`/api/history?${params}`)));
}

export async function getHistoryRising({ suffix, limit = 30 } = {}) {
  const params = withParams({ suffix, limit });
  return readJson(await fetch(apiUrl(`/api/history/rising?${params}`)));
}

export async function compareHistory({ suffix, snapshotId } = {}) {
  const params = withParams({ suffix, snapshotId });
  return readJson(await fetch(apiUrl(`/api/history/compare?${params}`)));
}

export async function getHistorySnapshot(id) {
  return readJson(await fetch(apiUrl(`/api/history/${encodeURIComponent(id)}`)));
}

export async function saveHistorySnapshot({ suffix, items, meta }) {
  return readJson(
    await fetch(apiUrl("/api/history/save"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ suffix, items, meta })
    })
  );
}
