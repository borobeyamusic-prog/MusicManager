# Borobeya Control Center

Local Node.js control center for Borobeya Music.

## What it does now

- Catalogs 37 released Borobeya Music tracks with ISRCs.
- Stores royalty plumbing fields: writer, publisher, ASCAP status, future ASCAP work ID.
- Adds a lightweight built-in vector search index with no external database dependency.
- Tracks A-Z workflows for creation, short videos, YouTube growth, Google Ads, Amazon store, sales tools, and ASCAP.
- Defines the Borobeya music-video workflow: lyrics/storyline -> scenes -> still images -> image-to-video clips -> final assembly.
- Provides API routes and a frontend dashboard.

## Run

```bash
npm start
```

Open:

```text
http://localhost:4179
```

## Check

```bash
npm run check
```

## Workflow design

- [ComfyUI album cover engine](COMFYUI_ALBUM_COVER_ENGINE.md)
- [Borobeya music video workflow](BOROBEYA_MUSIC_VIDEO_WORKFLOW.md)

## API

- `GET /api/dashboard`
- `GET /api/catalog`
- `GET /api/catalog/:id`
- `POST /api/catalog/import`
- `POST /api/catalog/:id/media`
- `GET /api/workflows`
- `GET /api/search?q=shorts`
- `POST /api/reindex`

## Next build steps

1. Add authenticated source connectors for DistroKid, Suno, YouTube, and Google Sheets.
2. Add file upload and media storage.
3. Add login for private access on the server.
4. Add SQLite or LanceDB/Qdrant backend if the catalog grows beyond local JSON.
5. Add action runners for YouTube/Google Ads/Amazon/ASCAP tasks.
6. Deploy to the Node host at `192.168.200.179`.

## Deploy to `192.168.200.179`

Once SSH auth is working:

```bash
chmod +x scripts/deploy-179.sh
./scripts/deploy-179.sh
```

If password login is not accepted, add your SSH key to the host first:

```bash
ssh-copy-id efrazad@192.168.200.179
```
