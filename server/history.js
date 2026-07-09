import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  attachHistorySignals,
  compareHostMaps,
  compactHostEntry
} from "./history-core.js";

export { attachHistorySignals, compareHostMaps, compactHostEntry };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const SNAPSHOT_DIR = path.join(DATA_DIR, "snapshots");
const INDEX_PATH = path.join(DATA_DIR, "index.json");
const MAX_SNAPSHOTS = 60;

async function ensureDirs() {
  await fs.mkdir(SNAPSHOT_DIR, { recursive: true });
  try {
    await fs.access(INDEX_PATH);
  } catch {
    await fs.writeFile(INDEX_PATH, JSON.stringify({ snapshots: [] }, null, 2));
  }
}

async function readIndex() {
  await ensureDirs();
  try {
    const raw = await fs.readFile(INDEX_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return {
      snapshots: Array.isArray(parsed.snapshots) ? parsed.snapshots : []
    };
  } catch {
    return { snapshots: [] };
  }
}

async function writeIndex(index) {
  await ensureDirs();
  await fs.writeFile(INDEX_PATH, JSON.stringify(index, null, 2));
}

export async function saveSnapshot({
  suffix = "vercel.app",
  items = [],
  meta = {}
} = {}) {
  await ensureDirs();
  const createdAt = new Date().toISOString();
  const id = createdAt.replace(/[:.]/g, "-");
  const hosts = {};

  for (const item of items) {
    const entry = compactHostEntry(item);
    if (!entry) continue;
    hosts[entry.host] = entry;
  }

  const snapshot = {
    id,
    createdAt,
    suffix,
    hostCount: Object.keys(hosts).length,
    meta,
    hosts
  };

  const filePath = path.join(SNAPSHOT_DIR, `${id}.json`);
  await fs.writeFile(filePath, JSON.stringify(snapshot, null, 2));

  const index = await readIndex();
  index.snapshots.unshift({
    id,
    createdAt,
    suffix,
    hostCount: snapshot.hostCount,
    path: `snapshots/${id}.json`
  });

  const keep = index.snapshots.slice(0, MAX_SNAPSHOTS);
  const drop = index.snapshots.slice(MAX_SNAPSHOTS);
  index.snapshots = keep;
  await writeIndex(index);

  for (const entry of drop) {
    try {
      await fs.unlink(path.join(SNAPSHOT_DIR, `${entry.id}.json`));
    } catch {
      // ignore
    }
  }

  return snapshot;
}

export async function listSnapshots({ limit = 30, suffix } = {}) {
  const index = await readIndex();
  let rows = index.snapshots;
  if (suffix) {
    rows = rows.filter((row) => row.suffix === suffix);
  }
  return rows.slice(0, Math.max(1, Math.min(100, limit)));
}

export async function getSnapshot(id) {
  if (!id || id.includes("..") || id.includes("/") || id.includes("\\")) {
    throw new Error("Invalid snapshot id");
  }
  await ensureDirs();
  const filePath = path.join(SNAPSHOT_DIR, `${id}.json`);
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

export async function getPreviousSnapshot(currentId, suffix) {
  const list = await listSnapshots({ limit: 40, suffix });
  if (!list.length) return null;

  // Ephemeral / "compare current batch" → previous is the latest saved snapshot.
  if (!currentId) {
    return list[0] ? getSnapshot(list[0].id) : null;
  }

  const index = list.findIndex((row) => row.id === currentId);
  if (index < 0) {
    return list[0] ? getSnapshot(list[0].id) : null;
  }
  const prev = list[index + 1];
  return prev ? getSnapshot(prev.id) : null;
}

export async function compareLatest({ suffix, items, snapshotId } = {}) {
  let current;

  if (snapshotId) {
    current = await getSnapshot(snapshotId);
  } else if (Array.isArray(items) && items.length) {
    current = {
      id: "ephemeral",
      createdAt: new Date().toISOString(),
      suffix: suffix || "vercel.app",
      hosts: Object.fromEntries(
        items
          .map((item) => compactHostEntry(item))
          .filter(Boolean)
          .map((entry) => [entry.host, entry])
      )
    };
  } else {
    const list = await listSnapshots({ limit: 2, suffix });
    if (!list.length) {
      return {
        ok: true,
        comparison: compareHostMaps({}, {}),
        current: null,
        previous: null
      };
    }
    current = await getSnapshot(list[0].id);
  }

  const previous = await getPreviousSnapshot(
    current.id === "ephemeral" ? null : current.id,
    suffix || current.suffix
  );

  const comparison = compareHostMaps(current.hosts || {}, previous?.hosts || {});

  return {
    ok: true,
    current: {
      id: current.id,
      createdAt: current.createdAt,
      hostCount: Object.keys(current.hosts || {}).length
    },
    previous: previous
      ? {
          id: previous.id,
          createdAt: previous.createdAt,
          hostCount: Object.keys(previous.hosts || {}).length
        }
      : null,
    comparison
  };
}

export async function getRisingHosts({ suffix, limit = 30 } = {}) {
  const result = await compareLatest({ suffix });
  const rising = result.comparison?.rising || [];
  return {
    ...result,
    items: rising.slice(0, limit)
  };
}
