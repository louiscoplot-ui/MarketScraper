# MotionCut

Local video editor web app. Flask + FFmpeg + HTML5 Canvas. Runs entirely on your machine — no cloud, no upload to a third party.

Drop a video, layer text and a logo, animate them, optionally drop in music, hit Export, and FFmpeg burns everything into a final MP4.

## Features

- Upload video (MP4, MOV up to 2 GB) and PNG/JPG images
- Live canvas overlay synced with video playback
- Text layers with 6 animations: tracking, reveal, typewriter, fade + 3D zoom + glow, bounce, cinematic
- Per-layer font, weight, size, color, position, start/end time
- Logo / watermark overlay (PNG) with preset positions and opacity
- Color overlay layers
- Visual effects: vignette, film grain, letterbox bars, color grade presets (Natural, Cinematic, Teal & Orange, Moody Dark, Bright & Airy, B&W)
- Music: upload MP3 / WAV, volume, fade in/out, replace or mix with original audio
- 5 built-in templates: Cinematic, Real Estate Drone, Travel, Social 9:16, Corporate
- Export 16:9 (1920×1080) and 9:16 (1080×1920)
- Progress bar during export
- Save / load project as JSON
- Undo / redo (Ctrl+Z / Ctrl+Y)
- Keyboard shortcuts: Space play/pause, ←/→ ±1 frame, Del remove layer

## Install on Windows

1. **Install FFmpeg** (Windows command prompt as admin):

   ```powershell
   winget install FFmpeg
   ```

   Verify:

   ```powershell
   ffmpeg -version
   ffprobe -version
   ```

   If `winget` isn't available, download the static build from <https://www.gyan.dev/ffmpeg/builds/> and add the `bin` folder to `PATH`.

2. **Install Python 3.10+** (if you don't already have it).

3. **Install dependencies**:

   ```powershell
   cd motioncut
   pip install -r requirements.txt
   ```

4. **Run**:

   ```powershell
   python app.py
   ```

5. Open <http://localhost:5000> in your browser.

## Project structure

```
motioncut/
├── app.py                    # Flask backend + FFmpeg export pipeline
├── requirements.txt          # flask, flask-cors
├── templates/
│   └── index.html            # main UI
├── static/
│   ├── css/style.css
│   └── js/editor.js          # canvas editor, layers, animations, export client
├── uploads/                  # auto-created on startup
└── exports/                  # rendered MP4s land here
```

## Notes

- All processing is local. Uploaded files live in `uploads/` and never leave your machine.
- Exported files are written to `exports/` with the filename `motioncut_<template>_<aspect>_<timestamp>.mp4`.
- Some animations are approximations on FFmpeg's side (drawtext can't do per-character animation, so bounce / typewriter render as fade-in titles in the final export, while the canvas preview is fully animated).
- For best font fidelity in the export, drop the `.ttf` file into `static/fonts/` and add `"fontFile": "<filename>.ttf"` to the layer (auto-wired through templates).
