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

export async function discoverCommonCrawl({ suffix, limit }) {
  const params = new URLSearchParams({ suffix, limit: String(limit) });
  return readJson(await fetch(apiUrl(`/api/discover/commoncrawl?${params}`)));
}

export async function discoverUrlscan({ suffix, limit }) {
  const params = new URLSearchParams({ suffix, limit: String(limit) });
  return readJson(await fetch(apiUrl(`/api/discover/urlscan?${params}`)));
}

export async function analyzeUrls({ urls, limit, source }) {
  return readJson(
    await fetch(apiUrl("/api/analyze"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ urls, limit, source })
    })
  );
}
