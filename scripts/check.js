const http = require("http");
const { spawn } = require("child_process");
const { resolve } = require("path");

const child = spawn(process.execPath, ["src/server.js"], {
  cwd: resolve(__dirname, ".."),
  env: { ...process.env, PORT: "4180" },
  stdio: ["ignore", "pipe", "pipe"]
});

function get(path) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:4180${path}`, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        } catch (error) {
          reject(error);
        }
      });
    }).on("error", reject);
  });
}

function post(path, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload || {});
    const req = http.request(`http://127.0.0.1:4180${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body)
      }
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  await new Promise((resolve) => setTimeout(resolve, 600));
  const health = await get("/api/health");
  const dashboard = await get("/api/dashboard");
  const catalog = await get("/api/catalog");
  const search = await get("/api/search?q=shorts%20mango%20ascap");
  if (!health.body.ok) throw new Error("Health check failed");
  if (dashboard.body.summary.tracks !== 37) throw new Error(`Expected 37 tracks, got ${dashboard.body.summary.tracks}`);
  if (!search.body.results.length) throw new Error("Search returned no results");
  const firstTrack = catalog.body[0];
  const videoProject = await post(`/api/catalog/${encodeURIComponent(firstTrack.id)}/video-project`, {
    draftSections: true,
    sectionCount: 7,
    clipsPerSection: 1,
    targetDurationSeconds: 180
  });
  if (!videoProject.body.project || videoProject.body.project.sections.length !== 7) {
    throw new Error("Video project draft route failed");
  }
  console.log("OK: health, dashboard, catalog seed, vector search, and video project draft are working.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  child.kill("SIGTERM");
});
