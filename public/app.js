const $ = (selector) => document.querySelector(selector);
let catalogCache = [];
let activeTrackId = "";

async function api(path, options) {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function card(label, value, hint) {
  return `<article class="card"><p>${label}</p><strong>${value}</strong><span>${hint || ""}</span></article>`;
}

function renderSummary(dashboard) {
  const { summary } = dashboard;
  $("#summary").innerHTML = [
    card("Tracks", summary.tracks, "DistroKid/ASCAP seed"),
    card("Priority", summary.priority, "Shorts/ad candidates"),
    card("Lyrics", summary.withLyrics, "Imported from Suno"),
    card("Missing assets", summary.missingMedia, "Needs audio/video/art/links"),
    card("Rights blocked", summary.blockedRights, "Waiting EIN/TIN match")
  ].join("");
}

function renderCatalog(items) {
  $("#catalog").innerHTML = items.map((item) => {
    const counts = assetCounts(item);
    return `
      <article class="track ${item.id === activeTrackId ? "active-track" : ""}" data-track-id="${escapeHtml(item.id)}">
      <div>
        <div class="row">
          <span class="badge p${item.priority}">P${item.priority}</span>
          <span class="muted">${item.isrc}</span>
          ${item.lyrics ? `<span class="badge ok">lyrics saved</span>` : `<span class="badge warn">no lyrics</span>`}
        </div>
        <h3>${escapeHtml(item.title)}</h3>
        <p>${escapeHtml(item.notes || "No notes yet.")}</p>
        ${item.lyrics ? `
          <p class="lyrics-proof">
            Lyrics: ${Number(item.lyrics.length || 0).toLocaleString()} chars
            ${item.lyrics.updatedAt ? `· saved ${escapeHtml(formatDate(item.lyrics.updatedAt))}` : ""}
            ${item.lyrics.sourceUrl ? `· <a href="${escapeHtml(item.lyrics.sourceUrl)}" target="_blank" rel="noreferrer">Suno source</a>` : ""}
          </p>
        ` : ""}
        ${renderStyleTags(item)}
        ${renderCoverPreview(item)}
        ${renderMediaLinks(item)}
        <div class="tags">${(item.tags || []).map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}</div>
      </div>
      <aside>
        <div class="asset-ledger" aria-label="Track asset counts">
          ${assetPill("Lyrics", counts.lyrics, counts.lyrics ? "ok" : "warn", item.id, "lyrics")}
          ${assetPill("Styles", counts.styles, counts.styles ? "ok" : "empty", item.id, "styles")}
          ${assetPill("Audio", counts.audio, counts.audio ? "ok" : "empty", item.id, "audio")}
          ${assetPill("Album", counts.albumCover, counts.albumCover ? "ok" : "empty", item.id, "album-cover")}
          ${assetPill("Video", counts.video, counts.video ? "ok" : "empty", item.id, "video")}
          ${assetPill("Links", counts.links, counts.links ? "ok" : "empty", item.id, "links")}
        </div>
        <button class="mini-button paste-lyrics" data-track-id="${escapeHtml(item.id)}" type="button">${item.lyrics ? "Replace" : "Paste"} lyrics</button>
        ${item.lyrics ? `<button class="mini-button view-lyrics" data-track-id="${escapeHtml(item.id)}" type="button">View saved</button>` : ""}
      </aside>
    </article>
    `;
  }).join("");

  document.querySelectorAll(".paste-lyrics").forEach((button) => {
    button.addEventListener("click", () => {
      loadRecord(button.dataset.trackId, "lyrics");
    });
  });

  document.querySelectorAll(".view-lyrics").forEach((button) => {
    button.addEventListener("click", () => loadRecord(button.dataset.trackId, "lyrics"));
  });

  document.querySelectorAll(".asset-pill").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      loadRecord(button.dataset.trackId, button.dataset.section);
    });
  });

  document.querySelectorAll(".track").forEach((track) => {
    track.addEventListener("click", (event) => {
      if (event.target.closest("button, a")) return;
      loadRecord(track.dataset.trackId, "record");
    });
  });
}

function assetCounts(item) {
  const media = item.media || [];
  const has = (patterns) => media.filter((entry) => {
    const text = `${entry.kind || ""} ${entry.label || ""} ${entry.url || ""} ${entry.notes || ""}`.toLowerCase();
    return patterns.some((pattern) => text.includes(pattern));
  }).length;

  return {
    lyrics: item.lyrics ? 1 : 0,
    styles: item.lyrics && Array.isArray(item.lyrics.styleTags) ? item.lyrics.styleTags.length : 0,
    audio: has(["audio", "mp3", "wav", "master", "song file"]),
    albumCover: media.filter((entry) => entry.kind === "album-cover").length,
    video: has(["video", "youtube", "short", "clip", "mp4", "mov"]),
    links: media.filter((entry) => entry.url).length
  };
}

function albumCovers(item) {
  return (item.media || []).filter((entry) => entry.kind === "album-cover").slice(0, 4);
}

function renderCoverPreview(item) {
  const covers = albumCovers(item);
  if (!covers.length) return "";
  return `
    <div class="cover-preview">
      <span>Album covers (${covers.length}/4)</span>
      <div>
        ${covers.map((cover) => `
          <a href="${escapeHtml(cover.url || cover.path || "#")}" target="_blank" rel="noreferrer">
            ${cover.url || cover.path ? `<img src="${escapeHtml(cover.url || cover.path)}" alt="${escapeHtml(cover.label || "Album cover")}" loading="lazy" />` : ""}
            <small>${escapeHtml(cover.label || "Album cover")}</small>
          </a>
        `).join("")}
      </div>
    </div>
  `;
}

function renderStyleTags(item) {
  const styles = item.lyrics && Array.isArray(item.lyrics.styleTags) ? item.lyrics.styleTags : [];
  if (!styles.length) return "";
  return `
    <div class="style-block">
      <span>Styles (${styles.length})</span>
      <div>${styles.map((style) => `<em>${escapeHtml(style)}</em>`).join("")}</div>
    </div>
  `;
}

function renderMediaLinks(item) {
  const links = (item.media || []).filter((entry) => entry.kind !== "album-cover" && (entry.url || entry.path));
  if (!links.length) return "";
  return `
    <div class="media-links">
      <span>Media / source links</span>
      <ul>
        ${links.map((entry) => `
          <li>
            <a href="${escapeHtml(entry.url || entry.path)}" target="_blank" rel="noreferrer">${escapeHtml(mediaLabel(entry))}</a>
            ${entry.kind ? `<small>${escapeHtml(entry.kind)}</small>` : ""}
          </li>
        `).join("")}
      </ul>
    </div>
  `;
}

function mediaLabel(entry) {
  if (entry.label) return entry.label;
  const value = entry.url || entry.path || "media link";
  try {
    const url = new URL(value, window.location.origin);
    const fileName = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() || "");
    return fileName || url.hostname || value;
  } catch {
    return value.split("/").filter(Boolean).pop() || value;
  }
}

function assetPill(label, value, status, trackId, section) {
  return `
    <button class="asset-pill ${status}" data-track-id="${escapeHtml(trackId)}" data-section="${escapeHtml(section)}" type="button">
      <span>${escapeHtml(label)}</span>
      <strong>${Number(value || 0).toLocaleString()}</strong>
    </button>
  `;
}

function renderWorkflows(workflows) {
  $("#workflows").innerHTML = workflows.map((workflow) => `
    <article class="workflow ${workflow.status}">
      <div class="row">
        <span class="badge">${escapeHtml(workflow.lane)}</span>
        <span class="status">${escapeHtml(workflow.status)}</span>
      </div>
      <h3>${escapeHtml(workflow.name)}</h3>
      <p>${escapeHtml(workflow.description)}</p>
      <ol>${workflow.actions.map((action) => `<li>${escapeHtml(action)}</li>`).join("")}</ol>
    </article>
  `).join("");
}

function renderResults(results) {
  $("#searchResults").innerHTML = results.length
    ? results.map((item) => `
      <article class="result">
        <span>${item.type || "item"} · score ${item.score}</span>
        <h3>${escapeHtml(item.title)}</h3>
        <p>${escapeHtml(item.notes || item.description || item.status || "")}</p>
      </article>
    `).join("")
    : `<p class="muted">No matches yet. Try “shorts”, “ASCAP”, “MANGO”, “ads”, or “Amazon”.</p>`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[char]));
}

function formatDate(value) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    }).format(new Date(value));
  } catch {
    return value;
  }
}

async function refreshCatalog() {
  const priority = $("#priorityFilter").value;
  catalogCache = await api("/api/catalog");
  populateLyricsTrackSelector(catalogCache);
  const filtered = priority ? catalogCache.filter((item) => String(item.priority) === priority) : catalogCache;
  renderCatalog(filtered);
}

function populateLyricsTrackSelector(items) {
  const current = $("#lyricsTrack").value;
  $("#lyricsTrack").innerHTML = items
    .map((item) => `<option value="${escapeHtml(item.id)}">${item.lyrics ? "✓" : "○"} ${escapeHtml(item.title)} — ${escapeHtml(item.isrc || "")}</option>`)
    .join("");
  if (current && items.some((item) => item.id === current)) $("#lyricsTrack").value = current;
}

function catalogTitle(id) {
  const item = catalogCache.find((entry) => entry.id === id);
  return item ? item.title : id;
}

function clearLyricsForm({ keepTrack = false } = {}) {
  if (!keepTrack && catalogCache[0]) $("#lyricsTrack").value = catalogCache[0].id;
  $("#lyricsSourceUrl").value = "";
  $("#lyricsStyleTags").value = "";
  $("#lyricsText").value = "";
  $("#lyricsStatus").textContent = "";
}

function clearMediaForm() {
  $("#mediaKind").value = "audio";
  $("#mediaLabel").value = "";
  $("#mediaUrl").value = "";
  $("#mediaNotes").value = "";
  $("#mediaPrompt").value = "";
  $("#mediaStatus").textContent = "";
}

async function refreshDashboard() {
  const dashboard = await api("/api/dashboard");
  renderSummary(dashboard);
}

async function submitLyrics(event) {
  event.preventDefault();
  const id = $("#lyricsTrack").value;
  const lyrics = $("#lyricsText").value.trim();
  const sourceUrl = $("#lyricsSourceUrl").value.trim();
  const styleTags = $("#lyricsStyleTags").value
    .split(/[,\n]/)
    .map((tag) => tag.trim())
    .filter(Boolean);

  if (!id) {
    $("#lyricsStatus").textContent = "Pick a catalog title first.";
    return;
  }
  if (lyrics.length < 20) {
    $("#lyricsStatus").textContent = "Paste the lyrics first — this looks too short.";
    return;
  }

  try {
    $("#lyricsStatus").textContent = "Saving...";
    const saved = await api(`/api/catalog/${encodeURIComponent(id)}/lyrics`, {
      method: "POST",
      body: JSON.stringify({
        lyrics,
        source: "manual-suno-paste",
        sourceUrl,
        styleTags
      })
    });

    $("#lyricsStatus").textContent = `Saved ${Number(saved.lyrics.length || 0).toLocaleString()} characters for ${catalogTitle(id)}.`;
    $("#lyricsText").value = "";
    $("#lyricsSourceUrl").value = "";
    $("#lyricsStyleTags").value = "";
    await refreshDashboard();
    await refreshCatalog();
    $("#lyricsTrack").value = id;
    activeTrackId = id;
  } catch (error) {
    $("#lyricsStatus").textContent = `Save failed: ${error.message}`;
  }
}

async function viewLyrics(id) {
  try {
    $("#lyricsTrack").value = id;
    $("#lyricsStatus").textContent = `Loading saved lyrics for ${catalogTitle(id)}...`;
    const data = await api(`/api/catalog/${encodeURIComponent(id)}/lyrics`);
    $("#lyricsSourceUrl").value = data.meta?.sourceUrl || "";
    $("#lyricsStyleTags").value = (data.meta?.styleTags || []).join("\n");
    $("#lyricsText").value = data.lyrics || "";
    $("#lyricsStatus").textContent = `Loaded saved lyrics for ${catalogTitle(id)} (${Number((data.lyrics || "").length).toLocaleString()} characters).`;
  } catch (error) {
    $("#lyricsStatus").textContent = `Could not load lyrics: ${error.message}`;
  }
}

async function loadRecord(id, section = "record") {
  const previousTrackId = activeTrackId;
  activeTrackId = id;
  const item = await api(`/api/catalog/${encodeURIComponent(id)}`);
  $("#lyricsTrack").value = id;
  $("#editorTitle").textContent = `${item.title} · ${sectionLabel(section)}`;
  if (previousTrackId !== id) clearMediaForm();
  $("#mediaKind").value = mediaKindForSection(section);
  renderMediaList(item);
  renderCoverGallery(item);

  if (section === "lyrics" || section === "styles" || section === "record") {
    if (item.lyrics) {
      await viewLyrics(id);
    } else {
      $("#lyricsSourceUrl").value = "";
      $("#lyricsStyleTags").value = "";
      $("#lyricsText").value = "";
      $("#lyricsStatus").textContent = `Loaded ${item.title}. No lyrics saved yet.`;
    }
  }

  await refreshCatalog();
  $("#lyricsTrack").value = id;
  document.querySelector(".lyrics-panel").scrollIntoView({ behavior: "smooth", block: "start" });

  if (section === "styles") $("#lyricsStyleTags").focus();
  else if (section === "lyrics") $("#lyricsText").focus();
  else if (section === "album-cover") $("#mediaPrompt").focus();
  else if (["audio", "cover", "video", "links"].includes(section)) $("#mediaUrl").focus();
}

function sectionLabel(section) {
  return ({
    lyrics: "Lyrics",
    styles: "Styles",
    audio: "Audio",
    cover: "Cover art",
    "album-cover": "Album Cover",
    video: "Video",
    links: "Links",
    record: "Record"
  })[section] || "Record";
}

function mediaKindForSection(section) {
  return ({
    audio: "audio",
    "album-cover": "album-cover",
    cover: "cover",
    video: "video",
    links: "link"
  })[section] || "audio";
}

function renderMediaList(item) {
  const media = (item.media || []).filter((entry) => entry.kind !== "album-cover");
  if (!media.length) {
    $("#mediaList").innerHTML = `<p>No media/source links saved yet for ${escapeHtml(item.title)}.</p>`;
    return;
  }
  $("#mediaList").innerHTML = `
    <p>${media.length} saved media/source item${media.length === 1 ? "" : "s"}:</p>
    <ul>
      ${media.map((entry) => `
        <li>
          <span>${escapeHtml(entry.kind || "link")}</span>
          ${entry.url ? `<a href="${escapeHtml(entry.url)}" target="_blank" rel="noreferrer">${escapeHtml(mediaLabel(entry))}</a>` : `<strong>${escapeHtml(entry.label || "Untitled media")}</strong>`}
          ${entry.notes ? `<small>${escapeHtml(entry.notes)}</small>` : ""}
        </li>
      `).join("")}
    </ul>
  `;
}

function renderCoverGallery(item) {
  const covers = albumCovers(item);
  const remaining = Math.max(0, 4 - covers.length);
  if (!covers.length) {
    $("#coverGallery").innerHTML = `<p>No album cover generations saved yet for ${escapeHtml(item.title)}. You can add up to 4.</p>`;
    return;
  }
  $("#coverGallery").innerHTML = `
    <p>Album cover generations: ${covers.length}/4 ${remaining ? `· ${remaining} slot${remaining === 1 ? "" : "s"} open` : "· full"}</p>
    <div class="cover-grid">
      ${covers.map((cover, index) => `
        <article class="cover-card">
          ${cover.url || cover.path ? `<a href="${escapeHtml(cover.url || cover.path)}" target="_blank" rel="noreferrer"><img src="${escapeHtml(cover.url || cover.path)}" alt="${escapeHtml(cover.label || `Album cover ${index + 1}`)}" loading="lazy" /></a>` : `<div class="cover-placeholder">No image path</div>`}
          <strong>${escapeHtml(cover.label || `Album cover ${index + 1}`)}</strong>
          ${cover.prompt ? `<small>${escapeHtml(cover.prompt)}</small>` : ""}
          ${cover.notes ? `<small>${escapeHtml(cover.notes)}</small>` : ""}
          <button class="mini-button delete-cover" data-media-key="${escapeHtml(cover.id || String((item.media || []).indexOf(cover)))}" type="button">Delete</button>
        </article>
      `).join("")}
    </div>
  `;
  document.querySelectorAll(".delete-cover").forEach((button) => {
    button.addEventListener("click", () => deleteMedia(item.id, button.dataset.mediaKey));
  });
}

async function submitMedia(event) {
  event.preventDefault();
  const id = activeTrackId || $("#lyricsTrack").value;
  if (!id) {
    $("#mediaStatus").textContent = "Pick or click a catalog record first.";
    return;
  }
  const payload = {
    kind: $("#mediaKind").value,
    label: $("#mediaLabel").value.trim(),
    url: $("#mediaUrl").value.trim(),
    notes: $("#mediaNotes").value.trim(),
    prompt: $("#mediaPrompt").value.trim()
  };
  if (!payload.url && !payload.label && !payload.prompt) {
    $("#mediaStatus").textContent = "Add at least a URL/path, display name, or prompt.";
    return;
  }

  try {
    $("#mediaStatus").textContent = "Saving media/link...";
    const saved = await api(`/api/catalog/${encodeURIComponent(id)}/media`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
    const counts = assetCounts(saved.item);
    const countText = saved.media.kind === "album-cover"
      ? `Album covers: ${counts.albumCover}/4`
      : `Links: ${counts.links}, Audio: ${counts.audio}, Video: ${counts.video}`;
    $("#mediaStatus").textContent = `Saved ${saved.media.kind || "media"} for ${saved.item.title}. ${countText}.`;
    clearMediaForm();
    activeTrackId = id;
    await refreshDashboard();
    await refreshCatalog();
    renderMediaList(saved.item);
    renderCoverGallery(saved.item);
    $("#lyricsTrack").value = id;
    $("#editorTitle").textContent = `${saved.item.title} · ${sectionLabel(saved.media.kind || "links")}`;
  } catch (error) {
    $("#mediaStatus").textContent = `Media save failed: ${error.message}`;
  }
}

async function deleteMedia(id, mediaKey) {
  try {
    $("#mediaStatus").textContent = "Deleting album cover...";
    const saved = await api(`/api/catalog/${encodeURIComponent(id)}/media/${encodeURIComponent(mediaKey)}`, {
      method: "DELETE"
    });
    $("#mediaStatus").textContent = `Deleted album cover from ${catalogTitle(id)}.`;
    activeTrackId = id;
    await refreshDashboard();
    await refreshCatalog();
    renderMediaList(saved.item);
    renderCoverGallery(saved.item);
    $("#lyricsTrack").value = id;
  } catch (error) {
    $("#mediaStatus").textContent = `Delete failed: ${error.message}`;
  }
}

async function boot() {
  const [dashboard, workflows] = await Promise.all([
    api("/api/dashboard"),
    api("/api/workflows")
  ]);
  renderSummary(dashboard);
  await refreshCatalog();
  renderWorkflows(workflows);

  $("#priorityFilter").addEventListener("change", refreshCatalog);
  $("#lyricsForm").addEventListener("submit", submitLyrics);
  $("#clearLyricsForm").addEventListener("click", () => clearLyricsForm({ keepTrack: true }));
  $("#mediaForm").addEventListener("submit", submitMedia);
  $("#clearMediaForm").addEventListener("click", clearMediaForm);
  $("#lyricsTrack").addEventListener("change", (event) => loadRecord(event.target.value, "record"));
  $("#search").addEventListener("input", async (event) => {
    const q = event.target.value.trim();
    if (!q) return renderResults([]);
    const data = await api(`/api/search?q=${encodeURIComponent(q)}`);
    renderResults(data.results);
  });
}

boot().catch((error) => {
  document.body.innerHTML = `<pre>${escapeHtml(error.stack || error.message)}</pre>`;
});
