async function readJson(response) {
  const payload = await response.json().catch(() => ({}));

  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }

  return payload;
}

export async function discoverCommonCrawl({ suffix, limit }) {
  const params = new URLSearchParams({ suffix, limit: String(limit) });
  return readJson(await fetch(`/api/discover/commoncrawl?${params}`));
}

export async function discoverUrlscan({ suffix, limit }) {
  const params = new URLSearchParams({ suffix, limit: String(limit) });
  return readJson(await fetch(`/api/discover/urlscan?${params}`));
}

export async function analyzeUrls({ urls, limit, source }) {
  return readJson(
    await fetch("/api/analyze", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ urls, limit, source })
    })
  );
}
