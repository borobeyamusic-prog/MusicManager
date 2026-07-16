# Borobeya Music Video Workflow

This is the working design for turning each Borobeya catalog title into album art, short clips, and eventually a full music video.

The core idea: Control Central is the producer/director, and each ComfyUI VM is a specialist worker.

## Current worker roles

| Role | Host | Job |
| --- | --- | --- |
| Control Central | `192.168.200.179:4179` | Catalog, prompts, storyline, job queue, approvals, final media records |
| Still image worker | `192.168.200.171:8188` | Album covers, keyframes, scene stills, character/world references |
| Video worker | `192.168.200.175:8188` | LTX image-to-video clips from approved stills/keyframes |
| Shared model/media storage | `192.168.200.89` | TrueNAS `comfy-share` NFS model and output storage |
| Third ComfyUI worker | TBD | Upscale, alternate video model, batch stills, experimental templates, or final polish |

## Big-picture pipeline

```text
Song record
  -> audio + lyrics intake
  -> lyrics/transcript cleanup
  -> story treatment
  -> 5-7 music-video sections
  -> 3-7 scenes/clips per section
  -> prompt package per scene
  -> scene still/keyframe generation on .171
  -> image-to-video clip generation on .175
  -> approval/retry board
  -> section assembly
  -> final music-video export
  -> saved back to catalog media
```

## Data objects

### Song

Already represented by the Control Central catalog record.

Important fields:

- title
- artist
- genre/style tags
- notes
- lyrics
- audio media
- album-cover media
- video media

### Music video project

One project belongs to one catalog title.

Suggested fields:

- `id`
- `catalogId`
- `title`
- `targetDurationSeconds`
- `visualWorld`
- `mainCharacters`
- `palette`
- `cameraStyle`
- `status`: `planning`, `images`, `videos`, `review`, `assembling`, `complete`
- `sections`

### Section

A section is a logical part of the song.

Examples: intro, verse 1, chorus, verse 2, bridge, final chorus, outro.

Suggested fields:

- `id`
- `name`
- `lyricRange`
- `summary`
- `emotion`
- `durationSeconds`
- `scenes`

### Scene

A scene is a clip production unit.

Suggested fields:

- `id`
- `sectionId`
- `order`
- `durationSeconds`
- `lyrics`
- `storyBeat`
- `imagePrompt`
- `videoPrompt`
- `negativePrompt`
- `cameraMotion`
- `width`
- `height`
- `fps`
- `seed`
- `sourceImageMediaId`
- `generatedImageMediaId`
- `generatedVideoMediaId`
- `targetWorker`: `.171`, `.175`, or future worker
- `status`: `planned`, `image-queued`, `image-done`, `video-queued`, `video-done`, `approved`, `redo`

## Prompt package

Every scene should have a reusable prompt package instead of one loose prompt.

```text
Scene image prompt:
  What the viewer sees as a still image.

Scene video prompt:
  How the still image should move over time.

Camera motion:
  slow dolly in, orbit, handheld push, crane rise, parallax drift, etc.

Continuity:
  character, clothing, color palette, environment, symbolic objects.

Negative prompt:
  text, logo, watermark, deformed hands, extra limbs, glitch, low quality.
```

## ChatGPT prompt rescue

Control Center includes a prompt-rescue lane for music-video scripting.

Two modes:

1. Paste source content: rough story idea, title description, lyrics, character notes, or creative brief.
2. Click the magic wand: draft the full treatment, visual world, character notes, palette, camera language, and scene prompts from the catalog record.

The goal is to let ChatGPT rescue the music-video script before spending render points:

- break the song into sections;
- create many 10-15 second clip ideas;
- write image prompts first;
- validate or regenerate images;
- animate approved images into clips;
- cut the final video to the song in Adobe Premiere.

For OpenArt, use `element2video` when a character/reference image should stay consistent across different scenes. Use `image2video` when the exact still image should become the first frame of the clip.

## First implementation target

Build the smallest useful version first:

1. Pick a catalog record.
2. Paste or load lyrics.
3. Use ChatGPT prompt rescue to draft the storyline, visual world, character notes, palette, and camera language.
4. Generate a 5-7 section storyline.
5. Fill per-scene prompt packages.
6. Generate 1 still image per scene on `.171`.
7. Validate or regenerate stills until the visual direction works.
8. Generate 10-15 second clips through `.175` local LTX or OpenArt via ChatGPT MCP.
9. Save generated images/videos back into the catalog media list.
10. Assemble approved clips in Adobe Premiere.

After that works, expand to 3-7 clips per section and add full assembly.

## Production defaults

Safe first defaults for local GPUs:

- image size: `1024x1024` for album covers
- video size: `768x512` or `768x768` for first LTX tests
- fps: `24`
- first clip duration: `4-8 seconds`
- target scene duration later: `10-30 seconds`
- full video structure: `5-7 sections`
- clips per section: `3-7`

For long music videos, prefer several short clips over one huge render. Short clips are easier to retry, approve, and stitch.

## Worker strategy

### `.171` still image worker

Use for:

- album cover concepts
- section keyframes
- character reference images
- location/background plates

### `.175` video worker

Use for:

- image-to-video clips
- first-frame/last-frame transitions
- LTX-2.3 motion variations

### Future third worker

Possible roles:

- upscaler/polish worker
- alternate video model worker
- background/asset batch worker
- caption/lyric visual worker
- experimental template sandbox

## Control Central screens to add

1. Music Video Builder panel on each catalog record.
2. Lyrics/storyline editor.
3. Section board.
4. Scene board.
5. Prompt package editor.
6. Generate still image button.
7. Generate video clip button.
8. Clip approval/retry board.
9. Final assembly/export area.

## Near-term build order

1. Store music-video projects in local JSON.
2. Add API routes:
   - `GET /api/catalog/:id/video-project`
   - `POST /api/catalog/:id/video-project`
   - `POST /api/catalog/:id/video-project/sections`
   - `POST /api/catalog/:id/video-project/scenes`
3. Add frontend scene planner.
4. Reuse the existing `.171` album-cover route for scene stills.
5. Add a `.175` LTX video route after the API workflow is stable.
6. Save all generated media to the catalog record.

## Design principle

Templates are references. Borobeya owns the workflow.

The app should make the repeatable production decisions:

- what gets generated
- where it gets generated
- how it is named
- where it is saved
- whether it is approved
- how it becomes part of the final music video
