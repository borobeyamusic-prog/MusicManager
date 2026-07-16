const https = require("https");

const openaiApiKey = process.env.OPENAI_API_KEY || "";
const openaiImageModel = process.env.OPENAI_IMAGE_MODEL || "gpt-image-2";

function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body || "";
    const headers = {
      "content-type": "application/json",
      ...(options.headers || {})
    };
    if (body) headers["content-length"] = Buffer.byteLength(body);

    const req = https.request(url, {
      method: options.method || "GET",
      headers,
      timeout: options.timeoutMs || 120000
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
    req.on("timeout", () => req.destroy(new Error(`OpenAI image request timed out: ${url.toString()}`)));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function isOpenAIConfigured() {
  return Boolean(openaiApiKey);
}

function checkOpenAIImageHealth() {
  return {
    configured: isOpenAIConfigured(),
    model: openaiImageModel,
    ready: isOpenAIConfigured()
  };
}

async function generateOpenAIImages({ prompt, count = 1, size = "1024x1024", quality = "high" }) {
  if (!isOpenAIConfigured()) {
    throw new Error("OpenAI image engine is not configured. Set OPENAI_API_KEY on the .179 server.");
  }

  const response = await requestJson(new URL("https://api.openai.com/v1/images/generations"), {
    method: "POST",
    timeoutMs: 180000,
    headers: {
      authorization: `Bearer ${openaiApiKey}`
    },
    body: JSON.stringify({
      model: openaiImageModel,
      prompt,
      n: count,
      size,
      quality
    })
  });

  if (!response.ok) {
    const body = response.body || {};
    const message = body.error && body.error.message || body.raw || `OpenAI image request failed with ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.body = body;
    throw error;
  }

  return (response.body.data || []).map((image, index) => ({
    index,
    b64_json: image.b64_json,
    url: image.url,
    revised_prompt: image.revised_prompt
  }));
}

module.exports = {
  checkOpenAIImageHealth,
  generateOpenAIImages,
  isOpenAIConfigured,
  openaiImageModel
};
