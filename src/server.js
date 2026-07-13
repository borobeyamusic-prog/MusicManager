const http = require("http");
const { extname, join, resolve } = require("path");
const { readFile } = require("fs").promises;
const { loadState, queryState, saveCatalog, saveLyrics, readLyrics, summarize } = require("./store");

const root = resolve(__dirname, "..");
const publicDir = resolve(root, "public");
const port = Number(process.env.PORT || 4179);

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

let state;

function mediaId() {
  return `media-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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

async function staticFile(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
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
      if (payload.kind === "album-cover") {
        const covers = (item.media || []).filter((entry) => entry.kind === "album-cover");
        if (covers.length >= 4) return send(res, 400, { error: "Maximum 4 album-cover generations per record" });
      }
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
