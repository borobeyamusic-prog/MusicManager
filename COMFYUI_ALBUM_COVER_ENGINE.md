# ComfyUI album cover engine

Last verified: 2026-07-13

## Purpose

Borobeya Control Center can use ComfyUI as a backend image engine for album-cover concept batches. The frontend selects a catalog title, sends album data and prompt notes to the Node backend, and the backend queues one or more ComfyUI Z-Image Turbo jobs.

## ComfyUI target

- Default ComfyUI API: `http://192.168.200.171:8188`
- Override with environment variable: `COMFYUI_BASE_URL`
- Workflow engine: Z-Image Turbo text-to-image

Required models:

| Model | Loader | Folder |
|---|---|---|
| `z_image_turbo_bf16.safetensors` | `UNETLoader` | `models/diffusion_models` |
| `qwen_3_4b.safetensors` | `CLIPLoader` | `models/text_encoders` |
| `ae.safetensors` | `VAELoader` | `models/vae` |

These are expected to live on the TrueNAS-backed ComfyUI model share.

## Backend files

- `src/comfyClient.js`
  - Builds the ComfyUI API prompt graph.
  - Queues `/prompt`.
  - Polls `/history/{prompt_id}`.
  - Converts output images into `/view?...` URLs.
  - Checks `/object_info` to verify required models.
- `src/server.js`
  - `GET /api/comfy/health`
  - `POST /api/catalog/:id/comfy/album-covers`
  - `GET /api/comfy/jobs/:jobId`
  - Runs album-cover batches as in-memory jobs.
  - Saves finished images back into catalog `media` entries with `kind: "album-cover"`.

## Frontend

The record editor now includes a ComfyUI panel with:

- image count
- width
- height
- steps
- optional seed
- prompt generator/editor textarea
- build prompt from selected album data
- copy prompt
- paste prompt
- clear prompt
- `Generate album covers`
- `Check ComfyUI`

The selected catalog record supplies title, artist, tags, notes, and lyric style tags. `Build from album` writes a full editable prompt into the textarea. If the textarea has content, that exact prompt is sent to ComfyUI.

## Smoke test

Verified live render through ComfyUI:

```text
Prompt ID: df078970-2ef6-4ea4-aba6-93e1acf478d5
Output: http://192.168.200.171:8188/view?filename=api-smoke-test_00001_.png&subfolder=borobeya%2Fapi-smoke-test&type=output
```

## Operational notes

- Generated images are stored by ComfyUI under output subfolders such as:

```text
borobeya/<track-id>/<track-id>-cover-001_00001_.png
```

- Job state is in-memory. If the Node server restarts, active job status is lost, but completed images already saved to the catalog remain.
- For large batches, keep jobs sequential at first to avoid overloading the P40 VM.
- The frontend polls job status every 2.5 seconds.

## Validation

Run:

```bash
npm run check
```

Live ComfyUI model health can be checked from the UI or directly:

```bash
node -e "const {checkHealth}=require('./src/comfyClient'); checkHealth().then(console.log)"
```
