"""
MotionCut - Local video editor web app.
Flask backend that handles uploads and FFmpeg-driven exports.
"""
import os
import re
import json
import time
import uuid
import shutil
import threading
import subprocess
from pathlib import Path
from flask import Flask, request, jsonify, send_from_directory, render_template, Response
from flask_cors import CORS

BASE_DIR = Path(__file__).resolve().parent
UPLOAD_DIR = BASE_DIR / "uploads"
EXPORT_DIR = BASE_DIR / "exports"
UPLOAD_DIR.mkdir(exist_ok=True)
EXPORT_DIR.mkdir(exist_ok=True)

ALLOWED_VIDEO = {".mp4", ".mov", ".m4v", ".webm"}
ALLOWED_IMAGE = {".jpg", ".jpeg", ".png"}
ALLOWED_AUDIO = {".mp3", ".wav", ".aac", ".m4a"}
MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024  # 2 GB

app = Flask(__name__, static_folder="static", template_folder="templates")
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_BYTES
CORS(app)

EXPORT_JOBS = {}
EXPORT_JOBS_LOCK = threading.Lock()


def ffmpeg_bin():
    return shutil.which("ffmpeg") or "ffmpeg"


def ffprobe_bin():
    return shutil.which("ffprobe") or "ffprobe"


def safe_filename(name: str) -> str:
    name = os.path.basename(name)
    name = re.sub(r"[^A-Za-z0-9._-]", "_", name)
    return name[:200] or f"file_{uuid.uuid4().hex}"


def escape_drawtext(s: str) -> str:
    """Escape text for FFmpeg drawtext filter."""
    if s is None:
        return ""
    s = s.replace("\\", "\\\\")
    s = s.replace(":", "\\:")
    s = s.replace("'", "\\'")
    s = s.replace("%", "\\%")
    s = s.replace(",", "\\,")
    return s


def escape_path_for_filter(p: str) -> str:
    """Escape a Windows path for use inside an FFmpeg filtergraph."""
    p = p.replace("\\", "/")
    p = p.replace(":", "\\:")
    p = p.replace("'", "\\'")
    return p


def hex_to_ffcolor(hex_color: str, alpha: float = 1.0) -> str:
    if not hex_color:
        hex_color = "#ffffff"
    hex_color = hex_color.lstrip("#")
    if len(hex_color) == 3:
        hex_color = "".join(c * 2 for c in hex_color)
    if len(hex_color) != 6:
        hex_color = "ffffff"
    a = max(0.0, min(1.0, float(alpha)))
    return f"0x{hex_color}@{a:.3f}"


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/uploads/<path:fname>")
def serve_upload(fname):
    return send_from_directory(UPLOAD_DIR, fname, conditional=True)


@app.route("/exports/<path:fname>")
def serve_export(fname):
    return send_from_directory(EXPORT_DIR, fname, conditional=True, as_attachment=False)


@app.route("/api/upload", methods=["POST"])
def upload():
    if "file" not in request.files:
        return jsonify({"error": "no file"}), 400
    f = request.files["file"]
    if not f.filename:
        return jsonify({"error": "empty filename"}), 400
    ext = os.path.splitext(f.filename)[1].lower()
    kind = request.form.get("kind", "auto")
    allowed = ALLOWED_VIDEO | ALLOWED_IMAGE | ALLOWED_AUDIO
    if ext not in allowed:
        return jsonify({"error": f"unsupported extension {ext}"}), 400
    detected = (
        "video" if ext in ALLOWED_VIDEO else
        "image" if ext in ALLOWED_IMAGE else
        "audio"
    )
    if kind != "auto" and kind != detected:
        return jsonify({"error": f"expected {kind}, got {detected}"}), 400
    new_name = f"{uuid.uuid4().hex}_{safe_filename(f.filename)}"
    dest = UPLOAD_DIR / new_name
    f.save(dest)

    info = {"filename": new_name, "kind": detected, "url": f"/uploads/{new_name}"}
    if detected == "video":
        info.update(probe_video(dest))
    return jsonify(info)


def probe_video(path: Path):
    try:
        out = subprocess.check_output(
            [
                ffprobe_bin(),
                "-v", "error",
                "-select_streams", "v:0",
                "-show_entries", "stream=width,height,duration,r_frame_rate",
                "-show_entries", "format=duration",
                "-of", "json",
                str(path),
            ],
            stderr=subprocess.STDOUT,
            timeout=30,
        )
        data = json.loads(out.decode("utf-8", errors="ignore"))
        stream = (data.get("streams") or [{}])[0]
        fmt = data.get("format") or {}
        duration = float(stream.get("duration") or fmt.get("duration") or 0)
        rate = stream.get("r_frame_rate", "30/1")
        try:
            num, den = rate.split("/")
            fps = float(num) / float(den) if float(den) != 0 else 30.0
        except Exception:
            fps = 30.0
        return {
            "width": int(stream.get("width") or 0),
            "height": int(stream.get("height") or 0),
            "duration": duration,
            "fps": fps,
        }
    except Exception as e:
        return {"width": 0, "height": 0, "duration": 0, "fps": 30.0, "probe_error": str(e)}


COLOR_GRADE_FILTERS = {
    "natural": "",
    "cinematic": "curves=preset=increase_contrast,eq=saturation=1.05:gamma=0.97",
    "teal_orange": "colorbalance=rs=0.15:gs=0.0:bs=-0.1:rm=0.05:gm=-0.05:bm=-0.1:rh=-0.1:gh=0.0:bh=0.15,eq=saturation=1.1",
    "moody_dark": "eq=contrast=1.1:brightness=-0.05:saturation=0.85:gamma=0.92",
    "bright_airy": "eq=contrast=0.95:brightness=0.06:saturation=1.05:gamma=1.05",
    "bw": "hue=s=0",
}


def build_filtergraph(payload, video_path: Path, exports_w: int, exports_h: int, src_w: int, src_h: int):
    """Build an FFmpeg filter_complex string for the export."""
    layers = payload.get("layers", [])
    effects = payload.get("effects", {}) or {}
    fit_mode = payload.get("fit", "cover")
    canvas_w = int(payload.get("canvasWidth") or exports_w)
    canvas_h = int(payload.get("canvasHeight") or exports_h)

    # Step 1: scale + pad video to target output size while preserving aspect.
    if fit_mode == "cover":
        base = (
            f"scale={exports_w}:{exports_h}:force_original_aspect_ratio=increase,"
            f"crop={exports_w}:{exports_h}"
        )
    else:
        base = (
            f"scale={exports_w}:{exports_h}:force_original_aspect_ratio=decrease,"
            f"pad={exports_w}:{exports_h}:(ow-iw)/2:(oh-ih)/2:black"
        )
    base += ",setsar=1"

    grade_key = (effects.get("colorGrade") or "natural").lower()
    grade = COLOR_GRADE_FILTERS.get(grade_key, "")
    if grade:
        base += f",{grade}"

    if effects.get("vignette"):
        base += ",vignette=PI/4"
    if effects.get("filmGrain"):
        base += ",noise=alls=12:allf=t+u"

    chain_parts = [f"[0:v]{base}[vbase]"]
    last_label = "vbase"
    next_idx = 1  # next input index for image overlays

    overlay_inputs = []  # list of (path, layer)

    sx = exports_w / float(canvas_w) if canvas_w else 1.0
    sy = exports_h / float(canvas_h) if canvas_h else 1.0

    # Letterbox bars
    if effects.get("letterbox"):
        bar_h = int(exports_h * 0.12)
        chain_parts.append(
            f"[{last_label}]drawbox=x=0:y=0:w={exports_w}:h={bar_h}:color=black@1.0:t=fill,"
            f"drawbox=x=0:y={exports_h - bar_h}:w={exports_w}:h={bar_h}:color=black@1.0:t=fill[vlb]"
        )
        last_label = "vlb"

    # Color overlay layers (full-screen tint)
    for idx, layer in enumerate(layers):
        if layer.get("type") != "color":
            continue
        color = hex_to_ffcolor(layer.get("color", "#000000"), float(layer.get("opacity", 0.3)))
        st = float(layer.get("startTime", 0))
        et = float(layer.get("endTime", 9999))
        out_label = f"vco{idx}"
        chain_parts.append(
            f"[{last_label}]drawbox=x=0:y=0:w={exports_w}:h={exports_h}:color={color}:t=fill:"
            f"enable='between(t,{st},{et})'[{out_label}]"
        )
        last_label = out_label

    # Text layers via drawtext
    for idx, layer in enumerate(layers):
        if layer.get("type") != "text":
            continue
        text = escape_drawtext(layer.get("text", ""))
        if not text:
            continue
        font_size = max(8, int(round(float(layer.get("fontSize", 48)) * sy)))
        x_px = int(round(float(layer.get("x", 0)) * sx))
        y_px = int(round(float(layer.get("y", 0)) * sy))
        color = hex_to_ffcolor(layer.get("color", "#ffffff"), float(layer.get("opacity", 1.0)))
        st = float(layer.get("startTime", 0))
        et = float(layer.get("endTime", 9999))
        anim = (layer.get("animation") or "none").lower()

        # Animation-driven alpha and position offsets
        alpha_expr = "1"
        x_expr = str(x_px)
        y_expr = str(y_px)
        text_for_filter = text

        fade_in = 0.6
        fade_out = 0.6

        if anim in ("fade", "fade_zoom", "cinematic"):
            alpha_expr = (
                f"if(lt(t,{st}),0,"
                f"if(lt(t,{st}+{fade_in}),(t-{st})/{fade_in},"
                f"if(lt(t,{et}-{fade_out}),1,"
                f"if(lt(t,{et}),({et}-t)/{fade_out},0))))"
            )
        elif anim == "bounce":
            y_expr = f"({y_px}) + 14*sin(2*PI*2*(t-{st}))*if(between(t,{st},{et}),1,0)"
            alpha_expr = (
                f"if(lt(t,{st}),0,if(lt(t,{st}+0.2),(t-{st})/0.2,if(lt(t,{et}),1,0)))"
            )
        elif anim == "tracking":
            # letter-spacing isn't supported in drawtext directly; approximate via fade
            alpha_expr = (
                f"if(lt(t,{st}),0,if(lt(t,{st}+0.8),(t-{st})/0.8,if(lt(t,{et}),1,0)))"
            )
        elif anim == "reveal":
            alpha_expr = (
                f"if(lt(t,{st}),0,if(lt(t,{st}+0.5),(t-{st})/0.5,if(lt(t,{et}),1,0)))"
            )
        elif anim == "typewriter":
            # crude: fade per second; full typewriter per-character isn't feasible in drawtext
            alpha_expr = (
                f"if(lt(t,{st}),0,if(lt(t,{et}),1,0))"
            )
        else:
            alpha_expr = f"if(between(t,{st},{et}),1,0)"

        font_file = layer.get("fontFile")
        font_arg = ""
        if font_file:
            ff_path = (BASE_DIR / "static" / "fonts" / font_file)
            if ff_path.exists():
                font_arg = f":fontfile='{escape_path_for_filter(str(ff_path))}'"

        box_arg = ""
        if layer.get("box"):
            box_color = hex_to_ffcolor(layer.get("boxColor", "#000000"), float(layer.get("boxOpacity", 0.5)))
            box_arg = f":box=1:boxcolor={box_color}:boxborderw=12"

        out_label = f"vt{idx}"
        chain_parts.append(
            f"[{last_label}]drawtext=text='{text_for_filter}':"
            f"fontcolor={color}:fontsize={font_size}:"
            f"x={x_expr}:y={y_expr}:"
            f"alpha='{alpha_expr}':"
            f"enable='between(t,{st},{et})'"
            f"{font_arg}{box_arg}[{out_label}]"
        )
        last_label = out_label

    # Logo / image layers as overlays
    for idx, layer in enumerate(layers):
        if layer.get("type") != "logo":
            continue
        src = layer.get("src", "")
        # src may be /uploads/<file> or a path
        m = re.match(r"^/uploads/(.+)$", src or "")
        if m:
            local_path = UPLOAD_DIR / m.group(1)
        else:
            local_path = Path(src)
        if not local_path.exists():
            continue
        overlay_inputs.append((str(local_path), layer, idx))

    audio_path = None
    audio_volume = 1.0
    audio_fade_in = False
    audio_fade_out = False
    audio_replace = True
    music = payload.get("music") or {}
    if music.get("src"):
        m = re.match(r"^/uploads/(.+)$", music.get("src"))
        if m:
            ap = UPLOAD_DIR / m.group(1)
            if ap.exists():
                audio_path = str(ap)
                audio_volume = max(0.0, min(2.0, float(music.get("volume", 1.0))))
                audio_fade_in = bool(music.get("fadeIn"))
                audio_fade_out = bool(music.get("fadeOut"))
                audio_replace = bool(music.get("replace", True))

    return {
        "video_chain_parts": chain_parts,
        "video_last_label": last_label,
        "overlay_inputs": overlay_inputs,
        "audio_path": audio_path,
        "audio_volume": audio_volume,
        "audio_fade_in": audio_fade_in,
        "audio_fade_out": audio_fade_out,
        "audio_replace": audio_replace,
        "scale_x": sx,
        "scale_y": sy,
    }


def build_ffmpeg_command(payload, video_path: Path, output_path: Path, target_w: int, target_h: int, src_w: int, src_h: int):
    plan = build_filtergraph(payload, video_path, target_w, target_h, src_w, src_h)
    cmd = [ffmpeg_bin(), "-y", "-i", str(video_path)]

    for path, _layer, _idx in plan["overlay_inputs"]:
        cmd += ["-i", path]

    audio_input_index = None
    if plan["audio_path"]:
        audio_input_index = 1 + len(plan["overlay_inputs"])
        cmd += ["-i", plan["audio_path"]]

    chain_parts = list(plan["video_chain_parts"])
    last_label = plan["video_last_label"]

    sx = plan["scale_x"]
    sy = plan["scale_y"]

    for n, (path, layer, layer_idx) in enumerate(plan["overlay_inputs"]):
        in_idx = n + 1
        w = int(round(float(layer.get("width", 200)) * sx))
        h = int(round(float(layer.get("height", 200)) * sy))
        x_px = int(round(float(layer.get("x", 0)) * sx))
        y_px = int(round(float(layer.get("y", 0)) * sy))
        opacity = max(0.0, min(1.0, float(layer.get("opacity", 1.0))))
        st = float(layer.get("startTime", 0))
        et = float(layer.get("endTime", 9999))

        scaled_label = f"img{layer_idx}s"
        chain_parts.append(
            f"[{in_idx}:v]scale={w}:{h},format=rgba,colorchannelmixer=aa={opacity:.3f}[{scaled_label}]"
        )
        out_label = f"vov{layer_idx}"
        chain_parts.append(
            f"[{last_label}][{scaled_label}]overlay={x_px}:{y_px}:"
            f"enable='between(t,{st},{et})'[{out_label}]"
        )
        last_label = out_label

    filter_complex = ";".join(chain_parts)

    cmd += ["-filter_complex", filter_complex, "-map", f"[{last_label}]"]

    if plan["audio_path"]:
        a_filters = [f"volume={plan['audio_volume']:.3f}"]
        if plan["audio_fade_in"]:
            a_filters.append("afade=t=in:st=0:d=1.5")
        if plan["audio_fade_out"]:
            duration = float(payload.get("duration") or 10)
            a_filters.append(f"afade=t=out:st={max(0, duration - 1.5):.3f}:d=1.5")
        a_chain = ",".join(a_filters)

        if plan["audio_replace"]:
            cmd += ["-filter_complex", f"[{audio_input_index}:a]{a_chain}[aout]", "-map", "[aout]"]
        else:
            mix = (
                f"[0:a]volume=1.0[a0];[{audio_input_index}:a]{a_chain}[a1];"
                f"[a0][a1]amix=inputs=2:duration=longest:dropout_transition=2[aout]"
            )
            cmd += ["-filter_complex", mix, "-map", "[aout]"]
        cmd += ["-c:a", "aac", "-b:a", "192k"]
    else:
        cmd += ["-map", "0:a?", "-c:a", "aac", "-b:a", "192k"]

    duration = float(payload.get("duration") or 0)
    if duration > 0:
        cmd += ["-t", f"{duration:.3f}"]

    cmd += [
        "-c:v", "libx264",
        "-preset", "medium",
        "-crf", "20",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        str(output_path),
    ]
    return cmd


def parse_progress_duration(line: str):
    m = re.search(r"time=(\d+):(\d+):(\d+\.?\d*)", line)
    if m:
        h, mn, s = m.groups()
        return int(h) * 3600 + int(mn) * 60 + float(s)
    return None


def run_export_job(job_id, cmd, output_path, total_duration):
    job = EXPORT_JOBS[job_id]
    try:
        job["status"] = "running"
        job["cmd"] = " ".join(cmd)
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            bufsize=1,
            universal_newlines=True,
        )
        job["pid"] = proc.pid
        log_lines = []
        for line in proc.stdout:
            log_lines.append(line.rstrip())
            if len(log_lines) > 400:
                log_lines = log_lines[-400:]
            t = parse_progress_duration(line)
            if t is not None and total_duration > 0:
                job["progress"] = max(0.0, min(0.99, t / total_duration))
        proc.wait()
        job["log"] = "\n".join(log_lines[-100:])
        if proc.returncode == 0 and output_path.exists():
            job["status"] = "done"
            job["progress"] = 1.0
            job["url"] = f"/exports/{output_path.name}"
        else:
            job["status"] = "error"
            job["error"] = f"ffmpeg exit {proc.returncode}"
    except Exception as e:
        job["status"] = "error"
        job["error"] = str(e)


@app.route("/api/export", methods=["POST"])
def export():
    payload = request.get_json(force=True, silent=True) or {}
    video_url = payload.get("videoUrl") or ""
    m = re.match(r"^/uploads/(.+)$", video_url)
    if not m:
        return jsonify({"error": "invalid videoUrl"}), 400
    video_path = UPLOAD_DIR / m.group(1)
    if not video_path.exists():
        return jsonify({"error": "video file missing"}), 400

    aspect = (payload.get("aspect") or "16:9").strip()
    if aspect == "9:16":
        target_w, target_h = 1080, 1920
    else:
        target_w, target_h = 1920, 1080

    probe = probe_video(video_path)
    src_w = probe.get("width", 1920) or 1920
    src_h = probe.get("height", 1080) or 1080
    duration = float(payload.get("duration") or probe.get("duration") or 10)
    payload["duration"] = duration

    template = (payload.get("template") or "custom").lower()
    template = re.sub(r"[^a-z0-9_-]", "_", template) or "custom"
    ts = time.strftime("%Y%m%d_%H%M%S")
    aspect_tag = "16x9" if aspect == "16:9" else "9x16"
    output_name = f"motioncut_{template}_{aspect_tag}_{ts}.mp4"
    output_path = EXPORT_DIR / output_name

    try:
        cmd = build_ffmpeg_command(payload, video_path, output_path, target_w, target_h, src_w, src_h)
    except Exception as e:
        return jsonify({"error": f"failed to build ffmpeg command: {e}"}), 500

    job_id = uuid.uuid4().hex
    with EXPORT_JOBS_LOCK:
        EXPORT_JOBS[job_id] = {
            "id": job_id,
            "status": "queued",
            "progress": 0.0,
            "url": None,
            "error": None,
            "output": output_name,
            "duration": duration,
        }

    t = threading.Thread(target=run_export_job, args=(job_id, cmd, output_path, duration), daemon=True)
    t.start()
    return jsonify({"jobId": job_id, "output": output_name})


@app.route("/api/export/status/<job_id>", methods=["GET"])
def export_status(job_id):
    job = EXPORT_JOBS.get(job_id)
    if not job:
        return jsonify({"error": "unknown job"}), 404
    return jsonify({
        "id": job["id"],
        "status": job["status"],
        "progress": job["progress"],
        "url": job["url"],
        "error": job["error"],
        "output": job["output"],
    })


@app.route("/api/export/stream/<job_id>")
def export_stream(job_id):
    def gen():
        last = None
        for _ in range(60 * 60):  # max ~1h
            job = EXPORT_JOBS.get(job_id)
            if not job:
                yield f"event: error\ndata: {json.dumps({'error':'unknown job'})}\n\n"
                return
            snapshot = {
                "status": job["status"],
                "progress": job["progress"],
                "url": job["url"],
                "error": job["error"],
            }
            if snapshot != last:
                yield f"data: {json.dumps(snapshot)}\n\n"
                last = snapshot
            if job["status"] in ("done", "error"):
                return
            time.sleep(1.0)
    return Response(gen(), mimetype="text/event-stream")


@app.route("/api/health")
def health():
    return jsonify({
        "ok": True,
        "ffmpeg": shutil.which("ffmpeg") is not None,
        "ffprobe": shutil.which("ffprobe") is not None,
    })


@app.errorhandler(413)
def too_large(_e):
    return jsonify({"error": "file too large (max 2GB)"}), 413


if __name__ == "__main__":
    print("MotionCut starting on http://localhost:5000")
    print(f"FFmpeg: {shutil.which('ffmpeg') or 'NOT FOUND - install with: winget install FFmpeg'}")
    app.run(host="127.0.0.1", port=5000, debug=False, threaded=True)
