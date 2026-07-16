const http = require("http");
const crypto = require("crypto");
const { extname, join, resolve } = require("path");
const { mkdir, readFile, writeFile } = require("fs").promises;
const { loadState, queryState, saveCatalog, saveVideoProjects, saveLyrics, readLyrics, summarize } = require("./store");
const {
  buildAlbumPrompt,
  buildZImageTurboPrompt,
  checkHealth: checkComfyHealth,
  checkVideoHealth: checkComfyVideoHealth,
  queuePrompt,
  slugify: slugifyComfyPath,
  waitForImages
} = require("./comfyClient");
const { checkOpenAIImageHealth, generateOpenAIImages, openaiImageModel } = require("./openaiImageClient");

const root = resolve(__dirname, "..");
const publicDir = resolve(root, "public");
const assetsRoot = process.env.BOROBEYA_ASSETS_DIR || resolve(root, "data/assets");
const generatedCoversRoot = resolve(assetsRoot, "generated-covers");
const port = Number(process.env.PORT || 4179);

const mime = {
  ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp"
};

let state;
const comfyJobs = new Map();

function slugify(value) {
  return String(value || "untitled")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90) || "untitled";
}

function mediaId() {
  return `media-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function randomId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return crypto.randomBytes(16).toString("hex");
}

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(type.includes("json") ? JSON.stringify(body, null, 2) : body);
}

async function bodyJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function parseDelimitedLine(line, delimiter) {
  const values = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === "\"" && quoted && next === "\"") {
      current += "\"";
      index += 1;
    } else if (char === "\"") {
      quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      values.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current.trim());
  return values;
}

function parseCatalogImport(payload) {
  const raw = String(payload.content || "").trim();
  if (!raw) throw new Error("Paste a CSV, TSV, or JSON export first.");

  if (raw.startsWith("{") || raw.startsWith("[")) {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.tracks)) return parsed.tracks;
    if (Array.isArray(parsed.catalog)) return parsed.catalog;
    throw new Error("JSON import must be an array, or include tracks/catalog.");
  }

  const lines = raw.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) throw new Error("Delimited import needs a header row and at least one record.");
  const delimiter = lines[0].includes("\t") ? "\t" : ",";
  const headers = parseDelimitedLine(lines[0], delimiter).map((header) => slugify(header).replace(/-/g, "_"));
  return lines.slice(1).map((line) => {
    const values = parseDelimitedLine(line, delimiter);
    return headers.reduce((record, header, index) => {
      record[header] = values[index] || "";
      return record;
    }, {});
  });
}

function pick(record, names) {
  for (const name of names) {
    if (record[name] !== undefined && record[name] !== null && String(record[name]).trim()) return String(record[name]).trim();
  }
  return "";
}

function splitTags(value) {
  if (Array.isArray(value)) return value.map(String).map((tag) => tag.trim()).filter(Boolean);
  return String(value || "")
    .split(/[;,|]/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function normalizeImportRecord(record, source, sourceUrl) {
  const title = pick(record, ["title", "song_title", "track_title", "name", "release_title"]);
  const isrc = pick(record, ["isrc", "isrc_code"]);
  if (!title && !isrc) return null;

  const id = pick(record, ["id", "slug", "track_id"]) || slugify(title || isrc);
  const tags = new Set([
    "imported",
    source,
    ...splitTags(record.tags),
    ...splitTags(record.platforms),
    ...splitTags(record.stores)
  ].filter(Boolean));

  const rights = {
    writer: pick(record, ["writer", "songwriter", "writers"]) || "ARDAVAN FARZAD",
    writerSplit: Number(pick(record, ["writer_split", "writer_split_percent"]) || 100),
    publisher: pick(record, ["publisher"]) || "BOROBEYA",
    publisherSplit: Number(pick(record, ["publisher_split", "publisher_split_percent"]) || 100),
    ascapStatus: pick(record, ["ascap_status"]) || "blocked-waiting-ein-tin-match",
    ascapWorkId: pick(record, ["ascap_work_id", "work_id"])
  };

  return {
    id,
    type: pick(record, ["type"]) || "music",
    title: title || isrc,
    artist: pick(record, ["artist", "primary_artist"]) || "Borobeya Music",
    isrc,
    status: pick(record, ["status"]) || "released",
    priority: Number(pick(record, ["priority"]) || 2),
    tags: [...tags],
    rights,
    media: Array.isArray(record.media) ? record.media : [],
    notes: pick(record, ["notes", "note", "description"]),
    source: {
      name: source,
      url: sourceUrl || "",
      importedAt: new Date().toISOString()
    }
  };
}

function mergeCatalogRecords(catalog, incomingRecords, source, sourceUrl) {
  const byId = new Map(catalog.map((item, index) => [item.id, index]));
  const byIsrc = new Map(catalog.filter((item) => item.isrc).map((item, index) => [String(item.isrc).toUpperCase(), index]));
  const byTitle = new Map(catalog.map((item, index) => [String(item.title || "").toLowerCase(), index]));
  const result = [...catalog];
  const importedAt = new Date().toISOString();
  const summary = { added: 0, updated: 0, skipped: 0, total: incomingRecords.length };

  for (const rawRecord of incomingRecords) {
    const incoming = normalizeImportRecord(rawRecord, source, sourceUrl);
    if (!incoming) {
      summary.skipped += 1;
      continue;
    }

    const index = byId.has(incoming.id)
      ? byId.get(incoming.id)
      : incoming.isrc && byIsrc.has(incoming.isrc.toUpperCase())
        ? byIsrc.get(incoming.isrc.toUpperCase())
        : byTitle.get(String(incoming.title || "").toLowerCase());

    if (index === undefined) {
      result.push(incoming);
      byId.set(incoming.id, result.length - 1);
      if (incoming.isrc) byIsrc.set(incoming.isrc.toUpperCase(), result.length - 1);
      byTitle.set(String(incoming.title || "").toLowerCase(), result.length - 1);
      summary.added += 1;
      continue;
    }

    const existing = result[index];
    result[index] = {
      ...existing,
      artist: incoming.artist || existing.artist,
      isrc: incoming.isrc || existing.isrc,
      status: incoming.status || existing.status,
      priority: incoming.priority || existing.priority,
      tags: [...new Set([...(existing.tags || []), ...(incoming.tags || [])])],
      rights: { ...(existing.rights || {}), ...(incoming.rights || {}) },
      media: [...(existing.media || []), ...(incoming.media || [])],
      notes: incoming.notes ? [existing.notes, incoming.notes].filter(Boolean).join(" | ") : existing.notes,
      source: {
        ...(existing.source || {}),
        latestImport: source,
        latestImportUrl: sourceUrl || "",
        importedAt
      }
    };
    summary.updated += 1;
  }

  return { catalog: result, summary };
}

async function staticFile(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith("/assets/")) {
    const assetPath = url.pathname.replace(/^\/assets\//, "");
    const target = resolve(join(assetsRoot, assetPath));
    if (!target.startsWith(assetsRoot)) return send(res, 403, { error: "Forbidden" });
    try {
      const content = await readFile(target);
      return send(res, 200, content, mime[extname(target)] || "application/octet-stream");
    } catch {
      return send(res, 404, { error: "Asset not found" });
    }
  }

  const path = url.pathname === "/" ? "/index.html" : url.pathname;
  const target = resolve(join(publicDir, path));
  if (!target.startsWith(publicDir)) return send(res, 403, { error: "Forbidden" });

  try {
    const content = await readFile(target);
    send(res, 200, content, mime[extname(target)] || "application/octet-stream");
  } catch {
    send(res, 404, { error: "Not found" });
  }
}

function nextActionsForItem(item) {
  const actions = [];
  if (item.priority === 1) actions.push("Create 15/30/45 second Shorts ad set.");
  if (!item.media || !item.media.length) actions.push("Attach audio, cover art, YouTube URL, or short clips.");
  if (!item.lyrics || !item.lyrics.length) actions.push("Paste or import verified lyrics.");
  if (!item.rights || !item.rights.ascapWorkId) actions.push("Register work with ASCAP after publisher account clears EIN/TIN matching.");
  if (item.tags && item.tags.includes("youtube")) actions.push("Audit YouTube title, description, pinned comment, playlist, and subscriber CTA.");
  if (!actions.length) actions.push("Ready for campaign QA.");
  return actions;
}

function splitLyricsIntoSections(lyrics, count) {
  const lines = String(lyrics || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return Array.from({ length: count }, () => "");
  const chunkSize = Math.max(1, Math.ceil(lines.length / count));
  return Array.from({ length: count }, (_, index) => lines.slice(index * chunkSize, (index + 1) * chunkSize).join("\n"));
}

function defaultVideoSections(item, lyrics, sectionCount = 7, clipsPerSection = 3) {
  const names = ["Intro", "Verse 1", "Chorus 1", "Verse 2", "Bridge", "Final Chorus", "Outro"];
  const excerpts = splitLyricsIntoSections(lyrics, sectionCount);
  const styleTags = item.lyrics && Array.isArray(item.lyrics.styleTags) ? item.lyrics.styleTags.join(", ") : "";
  return Array.from({ length: sectionCount }, (_, index) => {
    const name = names[index] || `Section ${index + 1}`;
    const sceneCount = Math.max(1, Math.min(7, clipsPerSection));
    const scenes = Array.from({ length: sceneCount }, (_, sceneIndex) => ({
      id: `scene-${Date.now().toString(36)}-${index + 1}-${sceneIndex + 1}-${randomId().slice(0, 5)}`,
      order: sceneIndex + 1,
      durationSeconds: 8,
      lyrics: sceneIndex === 0 ? excerpts[index] || "" : "",
      storyBeat: sceneIndex === 0
        ? `${name} establishes the emotional beat for "${item.title}".`
        : `${name} variation ${sceneIndex + 1}: continue the visual idea with a new camera angle.`,
      imagePrompt: [
        `Music video scene still for "${item.title}" by ${item.artist || "Borobeya Music"}.`,
        `Section: ${name}.`,
        styleTags ? `Music style: ${styleTags}.` : "",
        excerpts[index] ? `Lyric inspiration: ${excerpts[index].slice(0, 500)}` : "",
        "cinematic, premium, emotionally expressive, no text, no logo, strong composition"
      ].filter(Boolean).join(" "),
      videoPrompt: [
        `Animate this scene for the "${name}" section of "${item.title}".`,
        "Create smooth cinematic motion, emotional pacing, music-video energy, and visual continuity.",
        "Keep the subject coherent and avoid sudden identity changes."
      ].join(" "),
      negativePrompt: "text, logo, watermark, ugly, low quality, glitch, distorted hands, extra limbs, flicker",
      cameraMotion: sceneIndex % 2 === 0 ? "slow dolly in with subtle parallax" : "slow orbit with atmospheric motion",
      width: 768,
      height: 512,
      fps: 24,
      seed: "",
      sourceImageMediaId: "",
      generatedImageMediaId: "",
      generatedVideoMediaId: "",
      targetWorker: sceneIndex === 0 ? ".171 still image" : ".175 image-to-video",
      status: "planned"
    }));
    return {
      id: `section-${Date.now().toString(36)}-${index + 1}-${randomId().slice(0, 5)}`,
      order: index + 1,
      name,
      lyricRange: excerpts[index] ? `Auto chunk ${index + 1}` : "",
      summary: `${name} for "${item.title}": turn the lyric mood into a clear visual story beat.`,
      emotion: index === 0 ? "arrival / atmosphere" : index === sectionCount - 1 ? "resolution" : "build / motion",
      durationSeconds: sceneCount * 8,
      scenes
    };
  });
}

function findVideoProject(trackId) {
  return (state.videoProjects || []).find((project) => project.catalogId === trackId);
}

function findScene(project, sceneId) {
  for (const section of project.sections || []) {
    const scene = (section.scenes || []).find((entry) => entry.id === sceneId);
    if (scene) return { section, scene };
  }
  return {};
}

function upsertVideoProject(project) {
  state.videoProjects = state.videoProjects || [];
  const index = state.videoProjects.findIndex((entry) => entry.id === project.id || entry.catalogId === project.catalogId);
  if (index === -1) state.videoProjects.push(project);
  else state.videoProjects[index] = project;
  return project;
}

function baseVideoProject(item, payload = {}) {
  const now = new Date().toISOString();
  return {
    id: `video-${item.id}`,
    catalogId: item.id,
    title: `${item.title} music video`,
    targetDurationSeconds: clampNumber(payload.targetDurationSeconds, 180, 30, 600),
    visualWorld: payload.visualWorld || `Cinematic Borobeya world for "${item.title}" with luxury, emotion, and modern music-video polish.`,
    mainCharacters: payload.mainCharacters || "",
    palette: payload.palette || "deep contrast, neon accents, premium editorial color, cinematic shadows",
    cameraStyle: payload.cameraStyle || "slow dolly, parallax drift, orbit shots, dramatic close-ups",
    status: "planning",
    sections: [],
    createdAt: now,
    updatedAt: now
  };
}

async function readLyricsSafely(item) {
  if (!item || !item.lyrics || !item.lyrics.path) return "";
  try {
    return await readLyrics(item);
  } catch {
    return "";
  }
}

async function generateSceneStill(item, project, scene) {
  const seed = Number.isFinite(Number(scene.seed)) && Number(scene.seed) > 0
    ? Number(scene.seed)
    : Math.floor(Math.random() * 9_000_000_000_000_000);
  const width = clampNumber(scene.width, 768, 256, 2048);
  const height = clampNumber(scene.height, 512, 256, 2048);
  const prompt = [
    scene.imagePrompt || scene.storyBeat || `Music video scene still for "${item.title}".`,
    project.visualWorld ? `Visual world: ${project.visualWorld}` : "",
    project.mainCharacters ? `Continuity characters/objects: ${project.mainCharacters}` : "",
    project.palette ? `Palette: ${project.palette}` : "",
    "No text, no logo, no watermark."
  ].filter(Boolean).join("\n");
  const filenamePrefix = [
    "borobeya",
    "music-video-scenes",
    slugifyComfyPath(item.id),
    `${slugifyComfyPath(scene.id)}-still`
  ].join("/");
  const graph = buildZImageTurboPrompt({
    prompt,
    seed,
    width,
    height,
    steps: 8,
    filenamePrefix
  });
  const queued = await queuePrompt(graph);
  const images = await waitForImages(queued.prompt_id, { timeoutMs: 12 * 60 * 1000 });
  const firstImage = images[0];
  const media = {
    id: mediaId(),
    kind: "scene-still",
    label: `${item.title} scene ${scene.order || ""} still`,
    url: firstImage.url,
    path: firstImage.filename,
    notes: `Generated by ComfyUI .171 Z-Image Turbo · scene ${scene.id} · seed ${seed} · ${width}x${height}`,
    prompt,
    comfy: {
      worker: "192.168.200.171:8188",
      promptId: queued.prompt_id,
      seed,
      filename: firstImage.filename,
      subfolder: firstImage.subfolder,
      type: firstImage.type
    },
    addedAt: new Date().toISOString()
  };
  item.media = [...(item.media || []), media];
  scene.seed = seed;
  scene.generatedImageMediaId = media.id;
  scene.sourceImageMediaId = media.id;
  scene.status = scene.generatedVideoMediaId ? "video-done" : "image-done";
  return { media, promptId: queued.prompt_id };
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function imageSizeForOpenAI(width, height) {
  if (width > height) return "1536x1024";
  if (height > width) return "1024x1536";
  return "1024x1024";
}

async function saveGeneratedImageAsset(item, image, index, labelPrefix) {
  if (!image.b64_json) {
    return {
      url: image.url,
      path: image.url || ""
    };
  }
  const folder = join(generatedCoversRoot, slugify(item.id));
  await mkdir(folder, { recursive: true });
  const filename = `${slugify(labelPrefix)}-${String(index + 1).padStart(3, "0")}-${Date.now().toString(36)}.png`;
  const path = join(folder, filename);
  await writeFile(path, Buffer.from(image.b64_json, "base64"));
  return {
    url: `/assets/generated-covers/${slugify(item.id)}/${filename}`,
    path
  };
}

function newComfyJob(item, payload) {
  const count = clampNumber(payload.count, 4, 1, 50);
  const width = clampNumber(payload.width, 1024, 256, 2048);
  const height = clampNumber(payload.height, 1024, 256, 2048);
  const steps = clampNumber(payload.steps, 8, 1, 60);
  const baseSeed = Number.isFinite(Number(payload.seed)) && Number(payload.seed) > 0
    ? Number(payload.seed)
    : Math.floor(Math.random() * 9_000_000_000_000_000);
  const prompt = String(payload.prompt || "").trim() || buildAlbumPrompt(item, payload.promptNotes);
  const engine = payload.engine || "local-z-image";
  return {
    id: `comfy-${Date.now().toString(36)}-${randomId().slice(0, 8)}`,
    trackId: item.id,
    title: item.title,
    status: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    count,
    completed: 0,
    failed: 0,
    width,
    height,
    steps,
    baseSeed,
    prompt,
    engine,
    results: [],
    errors: []
  };
}

async function runComfyAlbumCoverJob(job) {
  job.status = "running";
  job.updatedAt = new Date().toISOString();
  const item = state.catalog.find((entry) => entry.id === job.trackId);
  if (!item) throw new Error("Catalog item disappeared before ComfyUI job started.");

  for (let index = 0; index < job.count; index += 1) {
    const seed = job.baseSeed + index;
    const filenamePrefix = `borobeya/${slugifyComfyPath(item.id)}/${slugifyComfyPath(item.id)}-cover-${String(index + 1).padStart(3, "0")}`;
    const prompt = buildZImageTurboPrompt({
      prompt: job.prompt,
      seed,
      width: job.width,
      height: job.height,
      steps: job.steps,
      filenamePrefix
    });

    try {
      job.updatedAt = new Date().toISOString();
      const queued = await queuePrompt(prompt);
      const promptId = queued.prompt_id;
      const images = await waitForImages(promptId);
      for (const image of images) {
        const media = {
          id: mediaId(),
          kind: "album-cover",
          label: `${item.title} cover ${job.results.length + 1}`,
          url: image.url,
          path: image.filename,
          notes: `Generated by ComfyUI Z-Image Turbo · seed ${seed} · ${job.width}x${job.height} · ${job.steps} steps`,
          prompt: job.prompt,
          comfy: {
            jobId: job.id,
            promptId,
            seed,
            filename: image.filename,
            subfolder: image.subfolder,
            type: image.type
          },
          addedAt: new Date().toISOString()
        };
        item.media = [...(item.media || []), media];
        job.results.push(media);
      }
      job.completed += 1;
      await saveCatalog(state.catalog);
    } catch (error) {
      job.failed += 1;
      job.errors.push({
        index: index + 1,
        seed,
        message: error.message || "ComfyUI generation failed"
      });
    }
  }

  job.status = job.failed === job.count ? "failed" : "completed";
  job.updatedAt = new Date().toISOString();
  await saveCatalog(state.catalog);
  state = await loadState();
}

async function runOpenAIAlbumCoverJob(job) {
  job.status = "running";
  job.updatedAt = new Date().toISOString();
  const item = state.catalog.find((entry) => entry.id === job.trackId);
  if (!item) throw new Error("Catalog item disappeared before OpenAI image job started.");

  try {
    const size = imageSizeForOpenAI(job.width, job.height);
    const images = await generateOpenAIImages({
      prompt: job.prompt,
      count: job.count,
      size,
      quality: "high"
    });

    for (const image of images) {
      const saved = await saveGeneratedImageAsset(item, image, job.results.length, `${item.id}-openai-cover`);
      const media = {
        id: mediaId(),
        kind: "album-cover",
        label: `${item.title} OpenAI cover ${job.results.length + 1}`,
        url: saved.url,
        path: saved.path,
        notes: `Generated by OpenAI ${openaiImageModel} · ${size}`,
        prompt: image.revised_prompt || job.prompt,
        openai: {
          jobId: job.id,
          model: openaiImageModel,
          index: image.index,
          revisedPrompt: image.revised_prompt || ""
        },
        addedAt: new Date().toISOString()
      };
      item.media = [...(item.media || []), media];
      job.results.push(media);
    }

    job.completed = job.results.length;
    job.status = "completed";
    job.updatedAt = new Date().toISOString();
    await saveCatalog(state.catalog);
    state = await loadState();
  } catch (error) {
    job.failed = job.count;
    job.status = "failed";
    job.updatedAt = new Date().toISOString();
    job.errors.push({ message: error.message || "OpenAI image generation failed" });
  }
}

function startComfyAlbumCoverJob(item, payload) {
  const job = newComfyJob(item, payload);
  comfyJobs.set(job.id, job);
  const runner = job.engine === "openai-image" ? runOpenAIAlbumCoverJob : runComfyAlbumCoverJob;
  runner(job).catch((error) => {
    job.status = "failed";
    job.updatedAt = new Date().toISOString();
    job.errors.push({ message: error.message || "Album cover generation failed" });
  });
  return job;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/api/health") {
      return send(res, 200, { ok: true, app: "Borobeya Control Center", port });
    }

    if (req.method === "GET" && url.pathname === "/api/dashboard") {
      return send(res, 200, {
        summary: summarize(state.catalog, state.workflows),
        priorityTracks: state.catalog.filter((item) => item.priority === 1),
        blocked: state.workflows.filter((workflow) => workflow.status === "blocked")
      });
    }

    if (req.method === "GET" && url.pathname === "/api/comfy/health") {
      return send(res, 200, await checkComfyHealth());
    }

    if (req.method === "GET" && url.pathname === "/api/comfy/video-health") {
      return send(res, 200, await checkComfyVideoHealth());
    }

    if (req.method === "GET" && url.pathname === "/api/comfy/cloud-health") {
      return send(res, 200, {
        openai: checkOpenAIImageHealth(),
        midjourney: {
          configured: false,
          ready: false,
          mode: "manual-import",
          note: "Midjourney is tracked as a manual/import engine until an official API integration is configured."
        }
      });
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/comfy/jobs/")) {
      const id = decodeURIComponent(url.pathname.split("/").pop());
      const job = comfyJobs.get(id);
      if (!job) return send(res, 404, { error: "ComfyUI job not found. Jobs are kept while the Control Center server is running." });
      return send(res, 200, job);
    }

    if (req.method === "GET" && url.pathname === "/api/catalog") {
      const status = url.searchParams.get("status");
      const priority = url.searchParams.get("priority");
      let catalog = [...state.catalog];
      if (status) catalog = catalog.filter((item) => item.status === status);
      if (priority) catalog = catalog.filter((item) => String(item.priority) === priority);
      return send(res, 200, catalog);
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/catalog/") && url.pathname.endsWith("/lyrics")) {
      const parts = url.pathname.split("/");
      const id = decodeURIComponent(parts[3]);
      const item = state.catalog.find((entry) => entry.id === id);
      if (!item) return send(res, 404, { error: "Catalog item not found" });
      if (!item.lyrics || !item.lyrics.path) return send(res, 404, { error: "No lyrics saved for this track yet" });
      const lyrics = await readLyrics(item);
      return send(res, 200, { item, lyrics, meta: item.lyrics });
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/catalog/") && url.pathname.endsWith("/video-project")) {
      const parts = url.pathname.split("/");
      const id = decodeURIComponent(parts[3]);
      const item = state.catalog.find((entry) => entry.id === id);
      if (!item) return send(res, 404, { error: "Catalog item not found" });
      const project = findVideoProject(id);
      return send(res, 200, { item, project });
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/catalog/") && url.pathname.endsWith("/video-project")) {
      const parts = url.pathname.split("/");
      const id = decodeURIComponent(parts[3]);
      const payload = await bodyJson(req);
      const item = state.catalog.find((entry) => entry.id === id);
      if (!item) return send(res, 404, { error: "Catalog item not found" });
      const now = new Date().toISOString();
      const existing = findVideoProject(id) || baseVideoProject(item, payload);
      const project = {
        ...existing,
        title: payload.title || existing.title,
        targetDurationSeconds: clampNumber(payload.targetDurationSeconds, existing.targetDurationSeconds || 180, 30, 600),
        visualWorld: payload.visualWorld || existing.visualWorld,
        mainCharacters: payload.mainCharacters || existing.mainCharacters,
        palette: payload.palette || existing.palette,
        cameraStyle: payload.cameraStyle || existing.cameraStyle,
        status: payload.status || existing.status || "planning",
        updatedAt: now
      };
      if (payload.draftSections) {
        const lyrics = await readLyricsSafely(item);
        project.sections = defaultVideoSections(
          item,
          lyrics,
          clampNumber(payload.sectionCount, 7, 1, 9),
          clampNumber(payload.clipsPerSection, 3, 1, 7)
        );
      } else if (Array.isArray(payload.sections)) {
        project.sections = payload.sections;
      }
      upsertVideoProject(project);
      await saveVideoProjects(state.videoProjects);
      return send(res, 200, { item, project });
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/catalog/") && url.pathname.endsWith("/video-project/scenes")) {
      const parts = url.pathname.split("/");
      const id = decodeURIComponent(parts[3]);
      const payload = await bodyJson(req);
      const item = state.catalog.find((entry) => entry.id === id);
      if (!item) return send(res, 404, { error: "Catalog item not found" });
      const project = findVideoProject(id) || upsertVideoProject(baseVideoProject(item, payload));
      const sectionId = payload.sectionId || (project.sections[0] && project.sections[0].id);
      const section = project.sections.find((entry) => entry.id === sectionId);
      if (!section) return send(res, 400, { error: "Create or select a section before adding scenes." });
      const order = (section.scenes || []).length + 1;
      const scene = {
        id: `scene-${Date.now().toString(36)}-${randomId().slice(0, 6)}`,
        order,
        durationSeconds: clampNumber(payload.durationSeconds, 8, 2, 60),
        lyrics: payload.lyrics || "",
        storyBeat: payload.storyBeat || `Scene ${order} for ${section.name}`,
        imagePrompt: payload.imagePrompt || "",
        videoPrompt: payload.videoPrompt || "",
        negativePrompt: payload.negativePrompt || "text, logo, watermark, low quality, glitch",
        cameraMotion: payload.cameraMotion || "slow cinematic dolly with subtle parallax",
        width: clampNumber(payload.width, 768, 256, 2048),
        height: clampNumber(payload.height, 512, 256, 2048),
        fps: clampNumber(payload.fps, 24, 1, 60),
        seed: payload.seed || "",
        sourceImageMediaId: payload.sourceImageMediaId || "",
        generatedImageMediaId: "",
        generatedVideoMediaId: "",
        targetWorker: payload.targetWorker || ".171 still image",
        status: payload.status || "planned"
      };
      section.scenes = [...(section.scenes || []), scene];
      section.durationSeconds = (section.scenes || []).reduce((total, entry) => total + Number(entry.durationSeconds || 0), 0);
      project.updatedAt = new Date().toISOString();
      upsertVideoProject(project);
      await saveVideoProjects(state.videoProjects);
      return send(res, 201, { item, project, scene });
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/catalog/") && url.pathname.includes("/video-project/scenes/") && url.pathname.endsWith("/generate-image")) {
      const parts = url.pathname.split("/");
      const id = decodeURIComponent(parts[3]);
      const sceneId = decodeURIComponent(parts[6]);
      const item = state.catalog.find((entry) => entry.id === id);
      if (!item) return send(res, 404, { error: "Catalog item not found" });
      const project = findVideoProject(id);
      if (!project) return send(res, 404, { error: "Create a music-video project first." });
      const { scene } = findScene(project, sceneId);
      if (!scene) return send(res, 404, { error: "Scene not found in this project." });

      try {
        scene.status = "image-queued";
        project.status = project.status === "planning" ? "images" : project.status;
        project.updatedAt = new Date().toISOString();
        await saveVideoProjects(state.videoProjects);
        const result = await generateSceneStill(item, project, scene);
        project.updatedAt = new Date().toISOString();
        await saveCatalog(state.catalog);
        await saveVideoProjects(state.videoProjects);
        return send(res, 200, { item, project, scene, media: result.media, promptId: result.promptId });
      } catch (error) {
        scene.status = "redo";
        scene.lastError = error.message || "Scene still generation failed";
        project.updatedAt = new Date().toISOString();
        await saveVideoProjects(state.videoProjects);
        return send(res, 500, { error: scene.lastError, project, scene });
      }
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/catalog/")) {
      const id = decodeURIComponent(url.pathname.split("/").pop());
      const item = state.catalog.find((entry) => entry.id === id);
      if (!item) return send(res, 404, { error: "Catalog item not found" });
      return send(res, 200, { ...item, nextActions: nextActionsForItem(item) });
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/catalog/") && url.pathname.endsWith("/media")) {
      const [, , , id] = url.pathname.split("/");
      const payload = await bodyJson(req);
      const item = state.catalog.find((entry) => entry.id === id);
      if (!item) return send(res, 404, { error: "Catalog item not found" });
      const media = {
        id: mediaId(),
        kind: payload.kind || "link",
        label: payload.label || payload.url || "Untitled media",
        url: payload.url || "",
        notes: payload.notes || "",
        prompt: payload.prompt || "",
        addedAt: new Date().toISOString()
      };
      item.media = [...(item.media || []), media];
      await saveCatalog(state.catalog);
      state = await loadState();
      return send(res, 201, { item, media });
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/catalog/") && url.pathname.endsWith("/comfy/album-covers")) {
      const parts = url.pathname.split("/");
      const id = decodeURIComponent(parts[3]);
      const payload = await bodyJson(req);
      const item = state.catalog.find((entry) => entry.id === id);
      if (!item) return send(res, 404, { error: "Catalog item not found" });
      const job = startComfyAlbumCoverJob(item, payload);
      return send(res, 202, job);
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/catalog/") && url.pathname.includes("/media/")) {
      const parts = url.pathname.split("/");
      const id = decodeURIComponent(parts[3]);
      const mediaKey = decodeURIComponent(parts[5]);
      const item = state.catalog.find((entry) => entry.id === id);
      if (!item) return send(res, 404, { error: "Catalog item not found" });
      const before = item.media || [];
      const numericIndex = Number(mediaKey);
      item.media = before.filter((entry, index) => {
        if (entry.id) return entry.id !== mediaKey;
        return index !== numericIndex;
      });
      if (item.media.length === before.length) return send(res, 404, { error: "Media item not found" });
      await saveCatalog(state.catalog);
      state = await loadState();
      return send(res, 200, { item, deleted: mediaKey });
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/catalog/") && url.pathname.endsWith("/lyrics")) {
      const parts = url.pathname.split("/");
      const id = decodeURIComponent(parts[3]);
      const payload = await bodyJson(req);
      const item = state.catalog.find((entry) => entry.id === id);
      if (!item) return send(res, 404, { error: "Catalog item not found" });
      if (!payload.lyrics || String(payload.lyrics).trim().length < 20) {
        return send(res, 400, { error: "Lyrics payload is too short" });
      }
      const lyrics = await saveLyrics(item, String(payload.lyrics), {
        source: payload.source || "suno",
        sourceUrl: payload.sourceUrl || "",
        styleTags: payload.styleTags || []
      });
      await saveCatalog(state.catalog);
      state = await loadState();
      return send(res, 201, { item, lyrics });
    }

    if (req.method === "POST" && url.pathname === "/api/catalog/import") {
      const payload = await bodyJson(req);
      const source = payload.source || "manual-import";
      const sourceUrl = payload.sourceUrl || "";
      const incoming = parseCatalogImport(payload);
      const merged = mergeCatalogRecords(state.catalog, incoming, source, sourceUrl);
      await saveCatalog(merged.catalog);
      state = await loadState();
      return send(res, 200, { ok: true, ...merged.summary, summary: summarize(state.catalog, state.workflows) });
    }

    if (req.method === "GET" && url.pathname === "/api/workflows") {
      return send(res, 200, state.workflows);
    }

    if (req.method === "GET" && url.pathname === "/api/search") {
      return send(res, 200, { q: url.searchParams.get("q") || "", results: queryState(state, url.searchParams.get("q") || "") });
    }

    if (req.method === "POST" && url.pathname === "/api/reindex") {
      state = await loadState();
      return send(res, 200, { ok: true, summary: summarize(state.catalog, state.workflows) });
    }

    return staticFile(req, res);
  } catch (error) {
    console.error(error);
    return send(res, 500, { error: error.message || "Internal server error" });
  }
});

loadState()
  .then((loaded) => {
    state = loaded;
    server.listen(port, "0.0.0.0", () => {
      console.log(`Borobeya Control Center running on http://0.0.0.0:${port}`);
    });
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
