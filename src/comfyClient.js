const crypto = require("crypto");
const http = require("http");
const https = require("https");

const defaultBaseUrl = process.env.COMFYUI_BASE_URL || "http://192.168.200.171:8188";

function randomId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return crypto.randomBytes(16).toString("hex");
}

const clientId = process.env.COMFYUI_CLIENT_ID || `borobeya-control-center-${randomId()}`;

function slugify(value) {
  return String(value || "untitled")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90) || "untitled";
}

function publicComfyUrl(path, params = {}) {
  const url = new URL(path, defaultBaseUrl);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  });
  return url.toString();
}

function buildAlbumPrompt(item, promptNotes = "") {
  const styleTags = item.lyrics && Array.isArray(item.lyrics.styleTags) ? item.lyrics.styleTags.join(", ") : "";
  const tags = Array.isArray(item.tags) ? item.tags.join(", ") : "";
  return [
    `Album cover artwork for "${item.title}" by ${item.artist || "Borobeya Music"}.`,
    item.notes ? `Song notes: ${item.notes}.` : "",
    styleTags ? `Music style: ${styleTags}.` : "",
    tags ? `Catalog tags: ${tags}.` : "",
    promptNotes || "cinematic luxury music cover, bold central subject, dramatic lighting, premium editorial design, clean composition, no text, no logo, square album art"
  ].filter(Boolean).join(" ");
}

function buildZImageTurboPrompt({
  prompt,
  seed,
  width = 1024,
  height = 1024,
  steps = 8,
  filenamePrefix = "borobeya/album-cover"
}) {
  return {
    "30": {
      class_type: "CLIPLoader",
      inputs: {
        clip_name: "qwen_3_4b.safetensors",
        type: "lumina2",
        device: "default"
      }
    },
    "29": {
      class_type: "VAELoader",
      inputs: {
        vae_name: "ae.safetensors"
      }
    },
    "28": {
      class_type: "UNETLoader",
      inputs: {
        unet_name: "z_image_turbo_bf16.safetensors",
        weight_dtype: "default"
      }
    },
    "27": {
      class_type: "CLIPTextEncode",
      inputs: {
        clip: ["30", 0],
        text: prompt
      }
    },
    "33": {
      class_type: "ConditioningZeroOut",
      inputs: {
        conditioning: ["27", 0]
      }
    },
    "13": {
      class_type: "EmptySD3LatentImage",
      inputs: {
        width,
        height,
        batch_size: 1
      }
    },
    "11": {
      class_type: "ModelSamplingAuraFlow",
      inputs: {
        model: ["28", 0],
        shift: 3
      }
    },
    "3": {
      class_type: "KSampler",
      inputs: {
        model: ["11", 0],
        positive: ["27", 0],
        negative: ["33", 0],
        latent_image: ["13", 0],
        seed,
        steps,
        cfg: 1,
        sampler_name: "res_multistep",
        scheduler: "simple",
        denoise: 1
      }
    },
    "8": {
      class_type: "VAEDecode",
      inputs: {
        samples: ["3", 0],
        vae: ["29", 0]
      }
    },
    "9": {
      class_type: "SaveImage",
      inputs: {
        images: ["8", 0],
        filename_prefix: filenamePrefix
      }
    }
  };
}

function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const body = options.body || "";
    const headers = {
      "content-type": "application/json",
      ...(options.headers || {})
    };
    if (body) headers["content-length"] = Buffer.byteLength(body);

    const req = transport.request(url, {
      method: options.method || "GET",
      headers,
      timeout: options.timeoutMs || 30000
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed = {};
        if (text) {
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = { raw: text };
          }
        }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: parsed });
      });
    });
    req.on("timeout", () => req.destroy(new Error(`ComfyUI request timed out: ${url.toString()}`)));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function comfyFetch(path, options = {}) {
  const url = new URL(path, defaultBaseUrl);
  const response = await requestJson(url, options);
  const body = response.body;
  if (!response.ok) {
    const error = new Error(body.error || body.raw || `ComfyUI request failed with ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

async function queuePrompt(prompt) {
  return comfyFetch("/prompt", {
    method: "POST",
    body: JSON.stringify({ prompt, client_id: clientId })
  });
}

async function getHistory(promptId) {
  return comfyFetch(`/history/${encodeURIComponent(promptId)}`);
}

async function waitForImages(promptId, { timeoutMs = 10 * 60 * 1000, pollMs = 1500 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const history = await getHistory(promptId);
    const entry = history[promptId];
    if (entry) {
      if (entry.status && entry.status.status_str === "error") {
        throw new Error(`ComfyUI job failed: ${JSON.stringify(entry.status)}`);
      }
      const outputs = entry.outputs || {};
      const images = Object.values(outputs)
        .flatMap((output) => output.images || [])
        .map((image) => ({
          filename: image.filename,
          subfolder: image.subfolder || "",
          type: image.type || "output",
          url: publicComfyUrl("/view", {
            filename: image.filename,
            subfolder: image.subfolder || "",
            type: image.type || "output"
          })
        }));
      if (images.length) return images;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`Timed out waiting for ComfyUI prompt ${promptId}`);
}

async function checkHealth() {
  const [systemStats, objectInfo] = await Promise.all([
    comfyFetch("/system_stats"),
    comfyFetch("/object_info")
  ]);
  const required = [
    ["UNETLoader", "unet_name", "z_image_turbo_bf16.safetensors"],
    ["CLIPLoader", "clip_name", "qwen_3_4b.safetensors"],
    ["VAELoader", "vae_name", "ae.safetensors"]
  ].map(([node, input, expected]) => {
    const values = (((objectInfo[node] || {}).input || {}).required || {})[input];
    const choices = Array.isArray(values) && Array.isArray(values[0]) ? values[0] : [];
    return { node, input, expected, found: choices.includes(expected) };
  });
  return {
    baseUrl: defaultBaseUrl,
    systemStats,
    required,
    ready: required.every((item) => item.found)
  };
}

module.exports = {
  buildAlbumPrompt,
  buildZImageTurboPrompt,
  checkHealth,
  queuePrompt,
  slugify,
  waitForImages
};
