#!/usr/bin/env bash
set -euo pipefail

HOST="${HOST:-192.168.200.179}"
USER="${USER:-efarzad}"
REMOTE_DIR="${REMOTE_DIR:-~/borobeya-control-center}"
ARCHIVE="${ARCHIVE:-/private/tmp/borobeya-control-center.tgz}"

echo "Creating remote app directory on ${USER}@${HOST}:${REMOTE_DIR}"
ssh "${USER}@${HOST}" "mkdir -p ${REMOTE_DIR}"

echo "Copying Borobeya Control Center files"
tar --no-xattrs -czf "${ARCHIVE}" package.json README.md COMFYUI_ALBUM_COVER_ENGINE.md BOROBEYA_MUSIC_VIDEO_WORKFLOW.md src public data/catalog.seed.json data/workflows.json scripts
scp "${ARCHIVE}" "${USER}@${HOST}:${REMOTE_DIR}/borobeya-control-center.tgz"
ssh "${USER}@${HOST}" "cd ${REMOTE_DIR} && tar -xzf borobeya-control-center.tgz"

echo "Checking remote app"
ssh "${USER}@${HOST}" "cd ${REMOTE_DIR} && npm run check"

echo "Done. Start with:"
echo "ssh ${USER}@${HOST} 'cd ${REMOTE_DIR} && PORT=4179 npm start'"
