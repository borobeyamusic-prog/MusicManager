const { mkdir, readFile, stat, writeFile } = require("fs").promises;
const { dirname, resolve, join } = require("path");
const { buildIndex, search } = require("./vector");

const root = resolve(__dirname, "..");
const catalogPath = resolve(root, "data/catalog.seed.json");
const workflowsPath = resolve(root, "data/workflows.json");
const runtimeCatalogPath = resolve(root, "data/catalog.runtime.json");
const videoProjectsPath = resolve(root, "data/video-projects.runtime.json");
const assetsRoot = process.env.BOROBEYA_ASSETS_DIR || resolve(root, "data/assets");
const lyricsRoot = resolve(assetsRoot, "lyrics");

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readJsonIfExists(path) {
  try {
    return await readJson(path);
  } catch {
    return null;
  }
}

async function writeJson(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2));
}

function safeFileName(value) {
  return String(value || "untitled")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "untitled";
}

async function loadState() {
  let catalog;
  try {
    catalog = await readJson(runtimeCatalogPath);
  } catch {
    catalog = await readJson(catalogPath);
    await writeJson(runtimeCatalogPath, catalog);
  }

  if (await reconcileLyricsFromAssets(catalog)) {
    await writeJson(runtimeCatalogPath, catalog);
  }

  const workflows = await readJson(workflowsPath);
  const videoProjects = await readJsonIfExists(videoProjectsPath) || [];
  const vectorIndex = buildIndex([
    ...catalog,
    ...workflows.map((workflow) => ({
      id: `workflow-${workflow.id}`,
      type: "workflow",
      title: workflow.name,
      status: workflow.status,
      tags: [workflow.lane, ...(workflow.actions || [])],
      notes: workflow.description
    }))
  ]);

  return { catalog, workflows, videoProjects, vectorIndex };
}

async function reconcileLyricsFromAssets(catalog) {
  let changed = false;
  for (const item of catalog) {
    const baseName = safeFileName(item.id);
    const path = join(lyricsRoot, `${baseName}.txt`);
    const metaPath = join(lyricsRoot, `${baseName}.json`);
    try {
      const [lyrics, info, sidecar] = await Promise.all([
        readFile(path, "utf8"),
        stat(path),
        readJsonIfExists(metaPath)
      ]);
      if (!lyrics.trim()) continue;
      const recovered = {
        path,
        length: lyrics.length,
        metaPath,
        updatedAt: sidecar && sidecar.updatedAt || info.mtime.toISOString(),
        source: sidecar && sidecar.source || item.lyrics && item.lyrics.source || "recovered-from-assets",
        sourceUrl: sidecar && sidecar.sourceUrl || item.lyrics && item.lyrics.sourceUrl || "",
        styleTags: sidecar && sidecar.styleTags || item.lyrics && item.lyrics.styleTags || []
      };
      if (
        !item.lyrics ||
        item.lyrics.path !== recovered.path ||
        item.lyrics.length !== recovered.length ||
        item.lyrics.source !== recovered.source ||
        item.lyrics.sourceUrl !== recovered.sourceUrl ||
        JSON.stringify(item.lyrics.styleTags || []) !== JSON.stringify(recovered.styleTags || [])
      ) {
        item.lyrics = {
          ...recovered
        };
        changed = true;
      }
    } catch {
      continue;
    }
  }
  return changed;
}

async function saveCatalog(catalog) {
  await writeJson(runtimeCatalogPath, catalog);
}

async function saveVideoProjects(videoProjects) {
  await writeJson(videoProjectsPath, videoProjects);
}

async function saveLyrics(item, lyrics, meta) {
  await mkdir(lyricsRoot, { recursive: true });
  const baseName = safeFileName(item.id);
  const path = join(lyricsRoot, `${baseName}.txt`);
  const metaPath = join(lyricsRoot, `${baseName}.json`);
  const updatedAt = new Date().toISOString();
  await writeFile(path, lyrics, "utf8");
  item.lyrics = {
    path,
    metaPath,
    length: lyrics.length,
    updatedAt,
    source: meta && meta.source || "manual",
    sourceUrl: meta && meta.sourceUrl || "",
    styleTags: meta && meta.styleTags || []
  };
  await writeJson(metaPath, {
    trackId: item.id,
    title: item.title,
    updatedAt,
    source: item.lyrics.source,
    sourceUrl: item.lyrics.sourceUrl,
    styleTags: item.lyrics.styleTags
  });
  return item.lyrics;
}

async function readLyrics(item) {
  if (!item || !item.lyrics || !item.lyrics.path) return "";
  return readFile(item.lyrics.path, "utf8");
}

function queryState(state, q) {
  return search(state.vectorIndex, q).map((result) => ({
    score: Number(result.score.toFixed(4)),
    ...result.item
  }));
}

function summarize(catalog, workflows) {
  const missingMedia = catalog.filter((item) => !item.media || item.media.length === 0).length;
  const blockedRights = catalog.filter((item) => item.rights && item.rights.ascapStatus && item.rights.ascapStatus.includes("blocked")).length;
  const priority = catalog.filter((item) => item.priority === 1).length;
  const workflowStatus = workflows.reduce((acc, workflow) => {
    acc[workflow.status] = (acc[workflow.status] || 0) + 1;
    return acc;
  }, {});

  return {
    tracks: catalog.length,
    priority,
    missingMedia,
    withLyrics: catalog.filter((item) => item.lyrics && item.lyrics.length > 0).length,
    blockedRights,
    workflows: workflowStatus
  };
}

module.exports = { loadState, saveCatalog, saveVideoProjects, saveLyrics, readLyrics, queryState, summarize };
