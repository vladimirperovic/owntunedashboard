# macOS menu bar control (SwiftBar)

Menubar item with current track + play/pause/next/volume, hitting the
dashboard API directly.

## Install

1. Install [SwiftBar](https://swiftbar.swiftbar.app) (brew install --cask swiftbar).
2. Pick a plugin folder in SwiftBar settings.
3. Copy `owntone.10s.sh` there and `chmod +x owntone.10s.sh`.
4. If the dashboard is not at `http://<your-dashboard-host>:3690`, export `OWNDASH_URL`.

Refresh interval is 10 s; actions fire immediately and refresh the bar.
