# ://

A blank terminal canvas where selected text can animate.

Published by **p1z**.

Run it in Windows Terminal or another ANSI-capable terminal:

```powershell
cd C:\Users\erikb\wordfx
npm start
```

Type normally. Hold **Shift** and use the arrow keys to mark text, then apply an effect:

- `Ctrl+R` — rainbow
- `Ctrl+T` — Matrix rain
- `Ctrl+P` — pulse
- `Ctrl+S` — sparkle
- `Ctrl+B` — bold
- `Ctrl+U` — underline
- `Ctrl+0` — remove effect
- `Ctrl+D` — remove effects when marked text has an active effect
- `F1` — hide/show the shortcut bar
- `Ctrl+Q` or `Ctrl+C` — quit
- `Enter` — scramble text into scrolling random letters that disappear one by one

With no text marked, an effect shortcut toggles that effect for newly typed text. Press the same shortcut again to turn it off. With text marked, the shortcut applies the effect only to that selection.

Typing `cato` or `jared` as a complete word automatically gives that name the rainbow effect. Matching is case-insensitive.

Typing `phantom` as a complete word censors it and displays a large glitching fake `FORBIDDEN ENTRY` error.

Typing `cmd` and pressing Enter starts a separate, authenticated command-mode process. Use `exit` to return to the :// canvas.

Direct canvas shortcuts that open private or higher-impact tools, including `cmd.note`, `cmd.fix`, `cmd.player`, and `cmd.update`, ask for the same login before they open.

Typing `cmd.brb` on the canvas and pressing Enter opens a skin-specific break screen. Each skin has its own message and animated motif; press Space to clear the terminal scrollback and return directly to the canvas.

Typing `cmd.note` on the canvas and pressing Enter, or entering `note` in command mode, opens a clean single-sentence note editor. Enter dissolves and appends the note with its local date, time, and UTC offset to `data/notes/notes.txt` beside the app.

In command mode, `nd` prompts for a directory where note and fix history should be stored. Paste a directory and press Enter, or use `nd "C:\Path With Spaces"` directly. The setting persists, applies to `note`, `fix`, and `nh`, and copies existing archives when the destination does not already contain them.

Typing `cmd.word` on the canvas and pressing Enter, or entering `word` in command mode, opens a timed 20-word typing game. Type each displayed word exactly; Escape returns to the canvas.

Typing `cmd.skin` on the canvas and pressing Enter, or entering `skin` in command mode, opens the global `://` skin selector. The Macintosh skin uses a dusty classic-system palette, desktop-style chrome, and a rotating bar spinner instead of loading bars. The selected skin persists across launches, then prompts to restart `://` so every screen reloads it. The old `theme` commands remain as aliases.

Available skins include Rainbow, Midnight, Neon, Ocean, Ember, Mono, Macintosh, Aurora, Phosphor, and Paper. Each carries its own palette, startup copy, spinner, loading motion, login identity, footer rail, and media visualization.

The media player also changes identity with the active skin. Playback, track, volume, and mute actions trigger skin-specific visual events such as prism trails, comets, neon flashes, ripples, sparks, constellations, CRT scans, and typewritten notices.

Typing `cmd.guide` on the canvas and pressing Enter opens the animation momentum guide. Escape, Q, or Enter returns to the canvas. The guide is also available as `guide` inside command mode.

Typing `cmd.player` opens the full-screen skinned media player; it is also available as `player` inside command mode. Space toggles playback, Left/Right changes tracks, Up/Down changes volume, and M toggles mute. The former `mediaplayer` and `mediactrl` commands remain compatibility aliases.

Typing `chat` in command mode opens a private two-person messenger in a separate terminal window, leaving the command console available. The host uses `chat host`, names the room, and sets the join code inside WordFX. The guest uses `chat join`, picks from the built-in live room list, and types the host's code. The full-screen chat keeps the current room's messages in a scrollable, memory-only history. It follows new messages while you are at the bottom; when you scroll up with the wheel, arrows, or Page Up/Page Down, a `↓ NEW` marker counts messages until you return to the bottom or start typing. Press `Ctrl+R` to enter or cancel reply selection, use Up/Down to choose a message, then press Enter to confirm. A live typing indicator appears whenever the other person is composing, messages send immediately without locking the composer, and the relay closes the room after neither participant has typed for two minutes. The room accepts one host and one guest, authenticates both ends with the code, end-to-end encrypts message payloads with AES-256-GCM, relays frames only in memory, and does not save them. Press Escape or use `/quit` to leave. Both computers need internet access and Node.js 22 or newer; Tailscale, router port forwarding, and inbound firewall rules are not required.

Typing `cmd.guild` on the canvas, or `guild` in command mode, opens shared guilds. Guilds are public relay-backed server spaces with a logo, a left-side user list, a right-side post board, online/idle/brb/offline presence, and direct messages between members. Press `N` from the guild list to create one, Enter to join, Tab or Up/Down on the board to focus users, Enter on a selected user to DM, and `Ctrl+B` to toggle brb. Idle is based on inactivity while the guild screen is open.

Typing `update` in command mode checks the public GitHub Releases feed, verifies the downloaded ZIP with SHA-256, installs only release-managed files, and restarts `://`. Personal credentials, notes, linked apps, linked directories, and skin preferences are preserved. The same updater is available directly from the canvas with `cmd.update`.

Typing `cmd.fix` on the canvas and pressing Enter, or entering `fix` in command mode, opens an issue editor. Enter appends the issue with a timestamp to the persistent `data/notes/fix.txt` archive for a later session.

Typing `nh` in command mode opens the note-history viewer. Arrow keys and Page Up/Page Down scroll; Q, Escape, or Enter returns to command mode. `nh` is intentionally unavailable from the main canvas.

Command mode is an authenticated launcher and Windows command console. It includes:

- Persistent app links with `link`, `run`, `apps`, and `unlink`
- Launch linked apps with `run <name>`
- Save directory shortcuts with `cdlink <name> <path>`; use `cdlink` to list them
- Browse with `cd <folder>`, `ls`, and `dir`, then open files or folders with `open <path>`
- `apps`, `cdlink`, `ls`, and `dir` open scrollable lists; folder contents mark directories, text, video, audio, images, and other files with distinct symbols
- In a list, type to search live, use arrows to select, press Enter to open an app/file or enter a folder, Backspace to move toward the linked starting folder without leaving it, and Escape to close
- Tab completion and command history
- `status`, `about`, `time`, and `echo`
- `monitor` opens a live CPU and memory dashboard; Q, Escape, or Enter returns
- `chat`, `chat host`, and `chat join` open the private Cloudflare messenger in a separate window
- `guild` opens shared guild boards, member presence, and direct messages
- `update` installs the latest verified GitHub release and restarts `://`
- Directory navigation with `pwd`, `cd`, `ls`, and `dir`
- `exec` opens a clean Windows command terminal in a new window
- `wsl` opens WSL in a new terminal window
- `clear`/`cls` to redraw the console and `exit` to return to the canvas

Paths containing spaces can be quoted, for example `link spotify "C:\Path To\Spotify.lnk"`. Type `help` inside command mode for the complete command index.

The command index is scrollable with the mouse wheel, arrow keys, Page Up/Page Down, Home, and End.

The canvas is intentionally ephemeral: quitting clears it.

## Sound effects

Windows builds load a 31-file soft sound library from the `sound` folder. The original procedural bank uses felt taps, warm chimes, filtered noise, smooth tape texture, and a rising bubble dissolve at restrained volume. Eight typing variations rotate across text-entry screens, while distinct cues cover navigation, selection, confirmation, commands, toggles, login, notes, errors, chat send/receive, notifications, and room joins/leaves. Run `npm run sounds:preview` to hear a short tour or `npm run sounds:generate` to rebuild every WAV deterministically. Missing files are ignored. Set `WORDFX_SOUND=0` before launch to disable all sound effects.

## Portable data

Each unzipped copy keeps its persistent state in a `data` folder beside `wordfx.js`. This includes notes, fixes, credentials, the selected skin, linked apps, and linked directories. The folder is created automatically on first launch, so moving the entire unzipped app keeps its state with it.

Existing installs automatically copy missing data from the former `%APPDATA%\slashslash` location on first launch. Set `SLASHSLASH_DATA_DIR` before launching only if you intentionally want a different storage folder.

Use the generated `dist/slashslash-windows.zip` when sharing a clean copy. The release build excludes the local `data` folder and other personal saves.

Opening quotes and brackets are paired automatically: `""`, `''`, `()`, `{}`, `[]`, and `<>`. The cursor stays between the pair; typing the closer advances over it, and Backspace removes an untouched pair.

## Sharing

Run `npm run release` to create `dist/slashslash-windows.zip`. The archive excludes credentials, notes, linked paths, shortcuts, and skin preferences. Recipients need Node.js installed, then can run `launch-wordfx.cmd`. On the first CMD launch, `://` asks them to register their own username and password.

User data stays inside the unzipped app's `data` folder. Passwords are never stored directly; registration uses a unique random salt and PBKDF2-SHA256 hash.
