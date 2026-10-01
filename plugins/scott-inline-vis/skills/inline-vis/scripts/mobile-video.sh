#!/usr/bin/env bash
# Produce a delivery copy. Never overwrite a capture or an existing output.
set -euo pipefail
if [[ $# != 2 ]]; then
  echo 'Usage: mobile-video.sh <capture> <delivery.mp4>' >&2
  exit 2
fi
ffmpeg -hide_banner -n -i "$1" -map 0:v:0 -map '0:a:0?' \
  -vf 'scale=w=min(1920\,iw):h=min(1080\,ih):force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1:out_range=tv,fps=30,format=yuv420p' \
  -color_range tv -c:v libx264 -preset slow -crf 18 -profile:v high -level:v 4.1 \
  -maxrate 12M -bufsize 24M -c:a aac -b:a 128k -movflags +faststart "$2"
