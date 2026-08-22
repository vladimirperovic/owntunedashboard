#!/bin/bash
# SwiftBar plugin — OwnTone Dashboard menubar control.
# Install: SwiftBar -> plugin folder -> save as "owntone.10s.sh", chmod +x.
# Point DASH at your dashboard if it is not on the default host.

DASH="${OWNDASH_URL:-http://localhost:3690}"
API="$DASH/api"

state=$(curl -fsS -m 3 "$API/player" 2>/dev/null)
[ -z "$state" ] && { echo "♪ OwnTone offline"; exit 0; }

playing=$(echo "$state" | grep -o '"state": "[a-z]*"' | head -1 | cut -d'"' -f4)
volume=$(echo "$state" | grep -o '"volume": [0-9]*' | head -1 | cut -d' ' -f2)

queue=$(curl -fsS -m 3 "$API/queue?id=now_playing" 2>/dev/null)
title=$(echo "$queue" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['items'][0].get('title',''))" 2>/dev/null)
artist=$(echo "$queue" | python3 -c "import json,sys;d=json.load(sys.stdin);i=d['items'][0];print(i.get('artist') or i.get('album_artist') or '')" 2>/dev/null)

case "$playing" in
  play)   icon="▶";  toggle="Pause" ;;
  pause)  icon="⏸";  toggle="Play"  ;;
  *)      icon="⏹";  toggle="Play"  ;;
esac

echo "${icon} ${title:-OwnTone} ${artist:+— $artist}"
echo "---"
echo "${toggle} | bash='$0' param1=toggle terminal=false refresh=true"
echo "Next | bash='$0' param1=next terminal=false refresh=true"
echo "Previous | bash='$0' param1=previous terminal=false refresh=true"
echo "Volume: ${volume}%"
for v in 10 20 30 50 75; do echo "  Set ${v}% | bash='$0' param1=vol param2=$v terminal=false refresh=true"; done
echo "---"
echo "Open dashboard | href=$DASH"

cmd="$1"; arg="$2"
[ -z "$cmd" ] && exit 0
case "$cmd" in
  toggle) curl -fsS -m 3 -X PUT "$API/player/toggle" >/dev/null ;;
  next)   curl -fsS -m 3 -X PUT "$API/player/next"   >/dev/null ;;
  previous) curl -fsS -m 3 -X PUT "$API/player/previous" >/dev/null ;;
  vol)    curl -fsS -m 3 -X PUT "$API/player/volume?volume=$arg" >/dev/null ;;
esac
