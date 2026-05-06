/* MotionCut editor — canvas overlay, layers, animations, templates, export */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const FONTS = ["Syne", "Orbitron", "Teko", "Playfair Display", "JetBrains Mono", "Bebas Neue", "Inter", "Arial"];
  const ANIMS = ["none", "tracking", "reveal", "typewriter", "fade", "bounce", "cinematic"];
  const ANIM_LABELS = {
    none: "None",
    tracking: "Tracking (letter-spacing)",
    reveal: "Reveal (scan line)",
    typewriter: "Typewriter",
    fade: "Fade + 3D Zoom + Glow",
    bounce: "Bounce (per-letter)",
    cinematic: "Cinematic Subtitle",
  };

  // -------- Application state --------
  const state = {
    media: null, // {url, width, height, duration, fps, kind}
    layers: [], // {id, type, ...}
    selectedId: null,
    canvasWidth: 1920,
    canvasHeight: 1080,
    aspect: "16:9",
    template: "custom",
    effects: {
      vignette: false,
      filmGrain: false,
      letterbox: false,
      colorGrade: "natural",
    },
    music: { src: null, name: null, volume: 0.8, fadeIn: false, fadeOut: false, replace: true },
    history: [],
    historyIdx: -1,
    historyMuted: false,
  };

  let video = null, canvas = null, ctx = null, overlayWrap = null;
  let drag = null;

  // -------- Utility --------
  const uid = () => Math.random().toString(36).slice(2, 10);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const fmtTime = (s) => {
    if (!isFinite(s)) s = 0;
    const m = Math.floor(s / 60);
    const ss = Math.floor(s % 60);
    return `${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  };

  // -------- History (undo/redo) --------
  function snapshot() {
    if (state.historyMuted) return;
    const s = JSON.stringify({
      layers: state.layers,
      effects: state.effects,
      music: state.music,
      template: state.template,
      aspect: state.aspect,
    });
    if (state.history[state.historyIdx] === s) return;
    state.history = state.history.slice(0, state.historyIdx + 1);
    state.history.push(s);
    if (state.history.length > 80) state.history.shift();
    state.historyIdx = state.history.length - 1;
  }
  function undo() {
    if (state.historyIdx <= 0) return;
    state.historyIdx -= 1;
    applyHistory();
  }
  function redo() {
    if (state.historyIdx >= state.history.length - 1) return;
    state.historyIdx += 1;
    applyHistory();
  }
  function applyHistory() {
    const s = state.history[state.historyIdx];
    if (!s) return;
    const obj = JSON.parse(s);
    state.layers = obj.layers || [];
    state.effects = obj.effects || state.effects;
    state.music = obj.music || state.music;
    state.template = obj.template || "custom";
    state.aspect = obj.aspect || state.aspect;
    syncEffectsUI();
    syncMusicUI();
    renderLayerList();
    renderLayerEditor();
    drawOverlay();
  }

  // -------- Layer factories --------
  function newTextLayer(opts = {}) {
    return {
      id: uid(),
      type: "text",
      text: "Your Title",
      fontFamily: "Syne",
      fontSize: 96,
      fontWeight: 700,
      color: "#ffffff",
      opacity: 1,
      letterSpacing: 0,
      x: 200, y: 400, // canvas-coords (canvasWidth x canvasHeight)
      width: 1500, height: 140,
      align: "left",
      animation: "fade",
      startTime: 0,
      endTime: 999,
      box: false,
      boxColor: "#000000",
      boxOpacity: 0.4,
      ...opts,
    };
  }
  function newLogoLayer(opts = {}) {
    return {
      id: uid(),
      type: "logo",
      src: "",
      img: null, // not serialized
      x: 60, y: 60,
      width: 240, height: 240,
      opacity: 1,
      startTime: 0,
      endTime: 999,
      ...opts,
    };
  }
  function newColorLayer(opts = {}) {
    return {
      id: uid(),
      type: "color",
      color: "#000000",
      opacity: 0.35,
      x: 0, y: 0,
      width: state.canvasWidth, height: state.canvasHeight,
      startTime: 0,
      endTime: 999,
      ...opts,
    };
  }

  // -------- Canvas sizing --------
  function setAspect(asp) {
    state.aspect = asp;
    if (asp === "9:16") {
      state.canvasWidth = 1080; state.canvasHeight = 1920;
    } else {
      state.canvasWidth = 1920; state.canvasHeight = 1080;
    }
    canvas.width = state.canvasWidth;
    canvas.height = state.canvasHeight;
    layoutStage();
    drawOverlay();
  }
  function layoutStage() {
    const wrap = $("canvasWrap");
    const wrapW = wrap.clientWidth - 24;
    const wrapH = wrap.clientHeight - 24;
    const r = state.canvasWidth / state.canvasHeight;
    let w = wrapW, h = wrapW / r;
    if (h > wrapH) { h = wrapH; w = h * r; }
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    video.style.width = `${w}px`;
    video.style.height = `${h}px`;
  }

  function canvasToScreenScale() {
    const rect = canvas.getBoundingClientRect();
    return { sx: rect.width / state.canvasWidth, sy: rect.height / state.canvasHeight, rect };
  }

  // -------- Drawing --------
  const COLOR_GRADE_FILTERS = {
    natural: "none",
    cinematic: "contrast(1.08) saturate(1.05) brightness(0.97)",
    teal_orange: "contrast(1.05) saturate(1.15) hue-rotate(-6deg)",
    moody_dark: "contrast(1.12) brightness(0.88) saturate(0.85)",
    bright_airy: "contrast(0.97) brightness(1.08) saturate(1.05)",
    bw: "grayscale(1) contrast(1.05)",
  };

  function applyVideoCSSFilter() {
    const grade = COLOR_GRADE_FILTERS[state.effects.colorGrade] || "none";
    video.style.filter = grade;
  }

  function drawOverlay() {
    if (!ctx) return;
    const W = state.canvasWidth, H = state.canvasHeight;
    ctx.clearRect(0, 0, W, H);

    const t = video && !isNaN(video.currentTime) ? video.currentTime : 0;

    // letterbox bars
    if (state.effects.letterbox) {
      const bar = Math.round(H * 0.12);
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, W, bar);
      ctx.fillRect(0, H - bar, W, bar);
    }

    // color overlays
    for (const layer of state.layers) {
      if (layer.type !== "color") continue;
      if (t < layer.startTime || t > layer.endTime) continue;
      ctx.save();
      ctx.globalAlpha = clamp(layer.opacity, 0, 1);
      ctx.fillStyle = layer.color;
      ctx.fillRect(layer.x, layer.y, layer.width, layer.height);
      ctx.restore();
    }

    // text + logo layers in order
    for (const layer of state.layers) {
      if (layer.type === "text") drawTextLayer(layer, t);
      else if (layer.type === "logo") drawLogoLayer(layer, t);
    }

    // vignette
    if (state.effects.vignette) {
      const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.7);
      g.addColorStop(0, "rgba(0,0,0,0)");
      g.addColorStop(1, "rgba(0,0,0,0.7)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
    if (state.effects.filmGrain) drawGrain(W, H);

    // selection box
    if (state.selectedId) {
      const sel = state.layers.find((l) => l.id === state.selectedId);
      if (sel) drawSelection(sel);
    }
  }

  function drawGrain(W, H) {
    // cheap noise: random sparse dots
    ctx.save();
    ctx.globalAlpha = 0.06;
    ctx.fillStyle = "#ffffff";
    const count = Math.floor((W * H) / 6000);
    for (let i = 0; i < count; i++) {
      const x = Math.random() * W;
      const y = Math.random() * H;
      ctx.fillRect(x, y, 1, 1);
    }
    ctx.restore();
  }

  function getAnimAlpha(layer, t) {
    if (t < layer.startTime || t > layer.endTime) return 0;
    const fadeIn = 0.6, fadeOut = 0.6;
    const local = t - layer.startTime;
    const dur = layer.endTime - layer.startTime;
    if (layer.animation === "fade" || layer.animation === "cinematic") {
      if (local < fadeIn) return local / fadeIn;
      if (t > layer.endTime - fadeOut) return Math.max(0, (layer.endTime - t) / fadeOut);
      return 1;
    }
    if (layer.animation === "tracking") {
      if (local < 0.8) return clamp(local / 0.8, 0, 1);
      return 1;
    }
    if (layer.animation === "reveal") return 1;
    if (layer.animation === "typewriter") return 1;
    if (layer.animation === "bounce") {
      if (local < 0.2) return clamp(local / 0.2, 0, 1);
      return 1;
    }
    return 1;
  }

  function drawTextLayer(layer, t) {
    if (t < layer.startTime || t > layer.endTime) return;
    const local = t - layer.startTime;
    const alpha = getAnimAlpha(layer, t) * (layer.opacity ?? 1);
    if (alpha <= 0.01) return;

    ctx.save();
    ctx.globalAlpha = alpha;

    let text = layer.text || "";
    let extraSpacing = layer.letterSpacing || 0;
    let yOffset = 0;
    let scale = 1;

    if (layer.animation === "tracking") {
      // expand letter spacing then collapse
      const p = clamp(local / Math.max(0.001, (layer.endTime - layer.startTime)), 0, 1);
      const phase = p < 0.5 ? p * 2 : (1 - p) * 2;
      extraSpacing = (layer.letterSpacing || 0) + 24 * phase;
    }
    if (layer.animation === "typewriter") {
      const cps = 14;
      const n = Math.floor(local * cps);
      text = (layer.text || "").slice(0, Math.max(0, n));
      if ((Math.floor(local * 2) % 2) === 0) text += "▍";
    }
    if (layer.animation === "fade") {
      const p = clamp(local / 0.8, 0, 1);
      scale = 0.9 + 0.1 * p;
    }
    if (layer.animation === "cinematic") {
      // subtle slide up
      const p = clamp(local / 0.7, 0, 1);
      yOffset = (1 - p) * 30;
    }

    ctx.font = `${layer.fontWeight || 700} ${layer.fontSize}px "${layer.fontFamily}", sans-serif`;
    ctx.textBaseline = "top";
    ctx.fillStyle = layer.color || "#fff";

    // glow for fade animation
    if (layer.animation === "fade") {
      ctx.shadowColor = "rgba(240,192,64,0.55)";
      ctx.shadowBlur = 24;
    }

    const baseX = layer.x;
    const baseY = layer.y + yOffset;

    if (layer.box) {
      const m = ctx.measureText(text);
      const w = m.width + 24;
      const h = layer.fontSize * 1.3;
      const ga = ctx.globalAlpha;
      ctx.globalAlpha = ga * (layer.boxOpacity ?? 0.5);
      ctx.fillStyle = layer.boxColor || "#000";
      ctx.fillRect(baseX - 12, baseY - 6, w, h);
      ctx.globalAlpha = ga;
      ctx.fillStyle = layer.color || "#fff";
    }

    // bounce: per-letter offset
    if (layer.animation === "bounce") {
      let cx = baseX;
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const off = Math.sin((local * 4 + i * 0.5)) * 10 * (1 - clamp(local / Math.max(0.001, (layer.endTime - layer.startTime)), 0, 1));
        ctx.fillText(ch, cx, baseY + off);
        cx += ctx.measureText(ch).width + extraSpacing;
      }
    } else if (extraSpacing > 0.5) {
      let cx = baseX;
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        ctx.fillText(ch, cx, baseY);
        cx += ctx.measureText(ch).width + extraSpacing;
      }
    } else {
      if (scale !== 1) {
        ctx.translate(baseX, baseY);
        ctx.scale(scale, scale);
        ctx.fillText(text, 0, 0);
      } else {
        ctx.fillText(text, baseX, baseY);
      }
    }

    // reveal: scan line wipe — draw a black bar that recedes
    if (layer.animation === "reveal") {
      const dur = Math.max(0.001, layer.endTime - layer.startTime);
      const p = clamp(local / Math.min(1.2, dur), 0, 1);
      const m = ctx.measureText(layer.text || "");
      const w = m.width + 40;
      const h = layer.fontSize * 1.4;
      const wipeX = baseX + w * p;
      ctx.fillStyle = "#000";
      ctx.fillRect(wipeX, baseY - 8, w - w * p, h);
      // gold scan line
      ctx.fillStyle = "#f0c040";
      ctx.fillRect(wipeX - 2, baseY - 8, 3, h);
    }

    ctx.restore();
  }

  function drawLogoLayer(layer, t) {
    if (t < layer.startTime || t > layer.endTime) return;
    if (!layer.img) return;
    ctx.save();
    ctx.globalAlpha = clamp(layer.opacity, 0, 1);
    try {
      ctx.drawImage(layer.img, layer.x, layer.y, layer.width, layer.height);
    } catch (_) { /* not loaded yet */ }
    ctx.restore();
  }

  function drawSelection(layer) {
    let x = layer.x, y = layer.y, w = layer.width || 0, h = layer.height || 0;
    if (layer.type === "text") {
      ctx.font = `${layer.fontWeight || 700} ${layer.fontSize}px "${layer.fontFamily}", sans-serif`;
      const m = ctx.measureText(layer.text || "M");
      w = Math.max(40, m.width + 16);
      h = (layer.fontSize || 48) * 1.3;
      x = layer.x - 8;
      y = layer.y - 4;
    }
    ctx.save();
    ctx.strokeStyle = "#f0c040";
    ctx.setLineDash([12, 8]);
    ctx.lineWidth = 3;
    ctx.strokeRect(x, y, w, h);
    // resize handle
    ctx.setLineDash([]);
    ctx.fillStyle = "#f0c040";
    ctx.fillRect(x + w - 14, y + h - 14, 14, 14);
    ctx.restore();
  }

  // -------- Layer hit-testing & dragging --------
  function layerBounds(layer) {
    if (layer.type === "text") {
      ctx.font = `${layer.fontWeight || 700} ${layer.fontSize}px "${layer.fontFamily}", sans-serif`;
      const m = ctx.measureText(layer.text || "M");
      const w = Math.max(40, m.width + 16);
      const h = (layer.fontSize || 48) * 1.3;
      return { x: layer.x - 8, y: layer.y - 4, w, h };
    }
    return { x: layer.x, y: layer.y, w: layer.width, h: layer.height };
  }
  function hitTest(canvasX, canvasY) {
    for (let i = state.layers.length - 1; i >= 0; i--) {
      const l = state.layers[i];
      if (l.type === "color") continue;
      const b = layerBounds(l);
      if (canvasX >= b.x && canvasX <= b.x + b.w && canvasY >= b.y && canvasY <= b.y + b.h) return l;
    }
    return null;
  }
  function hitResize(layer, canvasX, canvasY) {
    const b = layerBounds(layer);
    return canvasX >= b.x + b.w - 18 && canvasX <= b.x + b.w + 4 && canvasY >= b.y + b.h - 18 && canvasY <= b.y + b.h + 4;
  }

  function bindCanvasEvents() {
    canvas.addEventListener("mousedown", (e) => {
      const { sx, sy, rect } = canvasToScreenScale();
      const cx = (e.clientX - rect.left) / sx;
      const cy = (e.clientY - rect.top) / sy;

      const sel = state.selectedId ? state.layers.find((l) => l.id === state.selectedId) : null;
      if (sel && sel.type !== "color" && hitResize(sel, cx, cy)) {
        drag = { mode: "resize", id: sel.id, startX: cx, startY: cy, sx0: sel.fontSize || sel.width, sy0: sel.height };
        return;
      }
      const hit = hitTest(cx, cy);
      if (hit) {
        state.selectedId = hit.id;
        renderLayerList();
        renderLayerEditor();
        drag = { mode: "move", id: hit.id, offX: cx - hit.x, offY: cy - hit.y };
      } else {
        state.selectedId = null;
        renderLayerList();
        renderLayerEditor();
      }
      drawOverlay();
    });
    window.addEventListener("mousemove", (e) => {
      if (!drag) return;
      const { sx, sy, rect } = canvasToScreenScale();
      const cx = (e.clientX - rect.left) / sx;
      const cy = (e.clientY - rect.top) / sy;
      const layer = state.layers.find((l) => l.id === drag.id);
      if (!layer) return;
      if (drag.mode === "move") {
        layer.x = cx - drag.offX;
        layer.y = cy - drag.offY;
      } else if (drag.mode === "resize") {
        if (layer.type === "text") {
          const dy = cy - drag.startY;
          layer.fontSize = Math.max(10, Math.round(drag.sx0 + dy));
        } else {
          const dx = cx - drag.startX;
          const dy = cy - drag.startY;
          const ratio = (drag.sx0 && drag.sy0) ? (drag.sx0 / drag.sy0) : 1;
          layer.width = Math.max(20, Math.round(drag.sx0 + dx));
          layer.height = Math.max(20, Math.round(layer.width / ratio));
        }
      }
      drawOverlay();
    });
    window.addEventListener("mouseup", () => {
      if (drag) {
        snapshot();
        drag = null;
        renderLayerEditor();
      }
    });
  }

  // -------- Sidebar rendering --------
  function renderLayerList() {
    const list = $("layerList");
    list.innerHTML = "";
    if (!state.layers.length) {
      list.innerHTML = '<div class="muted small">No layers yet.</div>';
      return;
    }
    state.layers.forEach((l, i) => {
      const row = document.createElement("div");
      row.className = "layer-row" + (state.selectedId === l.id ? " selected" : "");
      const label = l.type === "text" ? (l.text || "(empty)") : l.type === "logo" ? "Logo" : "Color";
      row.innerHTML = `
        <span class="lr-icon">${l.type === "text" ? "T" : l.type === "logo" ? "◆" : "█"}</span>
        <span class="lr-label">${escapeHTML(label)}</span>
        <button class="lr-up" title="Up">▲</button>
        <button class="lr-down" title="Down">▼</button>
        <button class="lr-del" title="Delete">×</button>
      `;
      row.querySelector(".lr-label").onclick = () => {
        state.selectedId = l.id;
        renderLayerList();
        renderLayerEditor();
        drawOverlay();
      };
      row.querySelector(".lr-up").onclick = (e) => {
        e.stopPropagation();
        if (i > 0) { [state.layers[i - 1], state.layers[i]] = [state.layers[i], state.layers[i - 1]]; snapshot(); renderLayerList(); drawOverlay(); }
      };
      row.querySelector(".lr-down").onclick = (e) => {
        e.stopPropagation();
        if (i < state.layers.length - 1) { [state.layers[i + 1], state.layers[i]] = [state.layers[i], state.layers[i + 1]]; snapshot(); renderLayerList(); drawOverlay(); }
      };
      row.querySelector(".lr-del").onclick = (e) => {
        e.stopPropagation();
        deleteLayer(l.id);
      };
      list.appendChild(row);
    });
  }

  function deleteLayer(id) {
    state.layers = state.layers.filter((l) => l.id !== id);
    if (state.selectedId === id) state.selectedId = null;
    snapshot();
    renderLayerList();
    renderLayerEditor();
    drawOverlay();
  }

  function escapeHTML(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function renderLayerEditor() {
    const host = $("layerEditor");
    host.classList.remove("muted");
    const l = state.layers.find((x) => x.id === state.selectedId);
    if (!l) {
      host.innerHTML = "Select a layer to edit.";
      host.classList.add("muted");
      return;
    }
    if (l.type === "text") {
      host.innerHTML = `
        <label class="row">Text<textarea data-k="text" rows="2">${escapeHTML(l.text)}</textarea></label>
        <label class="row">Font
          <select data-k="fontFamily">
            ${FONTS.map((f) => `<option ${f === l.fontFamily ? "selected" : ""}>${f}</option>`).join("")}
          </select>
        </label>
        <div class="grid-2">
          <label class="row">Size <input data-k="fontSize" type="number" min="8" max="600" value="${l.fontSize}"></label>
          <label class="row">Weight
            <select data-k="fontWeight">
              ${[300,400,500,600,700,800,900].map((w) => `<option ${w === l.fontWeight ? "selected" : ""}>${w}</option>`).join("")}
            </select>
          </label>
          <label class="row">Color <input data-k="color" type="color" value="${l.color}"></label>
          <label class="row">Opacity <input data-k="opacity" type="range" min="0" max="1" step="0.05" value="${l.opacity}"></label>
          <label class="row">X <input data-k="x" type="number" value="${Math.round(l.x)}"></label>
          <label class="row">Y <input data-k="y" type="number" value="${Math.round(l.y)}"></label>
          <label class="row">Start (s) <input data-k="startTime" type="number" min="0" step="0.1" value="${l.startTime}"></label>
          <label class="row">End (s) <input data-k="endTime" type="number" min="0" step="0.1" value="${l.endTime}"></label>
        </div>
        <label class="row">Animation
          <select data-k="animation">
            ${ANIMS.map((a) => `<option value="${a}" ${a === l.animation ? "selected" : ""}>${ANIM_LABELS[a]}</option>`).join("")}
          </select>
        </label>
        <label class="row inline"><input type="checkbox" data-k="box" ${l.box ? "checked" : ""}> Background box</label>
      `;
    } else if (l.type === "logo") {
      host.innerHTML = `
        <div class="muted small">Logo image</div>
        <div class="grid-2">
          <label class="row">X <input data-k="x" type="number" value="${Math.round(l.x)}"></label>
          <label class="row">Y <input data-k="y" type="number" value="${Math.round(l.y)}"></label>
          <label class="row">Width <input data-k="width" type="number" value="${Math.round(l.width)}"></label>
          <label class="row">Height <input data-k="height" type="number" value="${Math.round(l.height)}"></label>
          <label class="row">Opacity <input data-k="opacity" type="range" min="0" max="1" step="0.05" value="${l.opacity}"></label>
          <label class="row">Start (s) <input data-k="startTime" type="number" min="0" step="0.1" value="${l.startTime}"></label>
          <label class="row">End (s) <input data-k="endTime" type="number" min="0" step="0.1" value="${l.endTime}"></label>
        </div>
      `;
    } else if (l.type === "color") {
      host.innerHTML = `
        <label class="row">Color <input data-k="color" type="color" value="${l.color}"></label>
        <label class="row">Opacity <input data-k="opacity" type="range" min="0" max="1" step="0.05" value="${l.opacity}"></label>
      `;
    }

    host.querySelectorAll("[data-k]").forEach((el) => {
      el.addEventListener("input", () => {
        const k = el.getAttribute("data-k");
        let v = el.type === "checkbox" ? el.checked : el.value;
        if (el.type === "number" || el.type === "range") v = Number(v);
        l[k] = v;
        renderLayerList();
        drawOverlay();
      });
      el.addEventListener("change", snapshot);
    });
  }

  // -------- Templates --------
  function applyTemplate(name) {
    state.template = name;
    state.layers = [];
    state.selectedId = null;
    state.effects.letterbox = false;
    state.effects.vignette = false;

    if (name === "cinematic") {
      setAspect("16:9");
      state.effects.letterbox = true;
      state.effects.vignette = true;
      state.effects.colorGrade = "cinematic";
      state.layers.push(newTextLayer({
        text: "CINEMATIC TITLE",
        fontFamily: "Playfair Display", fontWeight: 700, fontSize: 120,
        color: "#ffffff", x: 260, y: 760, animation: "cinematic", startTime: 0.5, endTime: 8,
      }));
      state.layers.push(newTextLayer({
        text: "A subtitle in the style of cinema",
        fontFamily: "Syne", fontWeight: 400, fontSize: 44,
        color: "#f0c040", x: 260, y: 920, animation: "fade", startTime: 1.0, endTime: 8,
      }));
    } else if (name === "real_estate") {
      setAspect("16:9");
      state.effects.colorGrade = "bright_airy";
      state.layers.push(newTextLayer({
        text: "12 Ocean Drive",
        fontFamily: "Orbitron", fontWeight: 800, fontSize: 84,
        color: "#ffffff", x: 80, y: 880, animation: "tracking", startTime: 0.5, endTime: 999,
      }));
      state.layers.push(newTextLayer({
        text: "$2,450,000",
        fontFamily: "Orbitron", fontWeight: 700, fontSize: 56,
        color: "#0a0a0a", x: 1500, y: 80, animation: "fade",
        startTime: 0.5, endTime: 999, box: true, boxColor: "#f0c040", boxOpacity: 1,
      }));
      state.layers.push(newTextLayer({
        text: "Bondi · Sydney",
        fontFamily: "Syne", fontWeight: 500, fontSize: 36,
        color: "#f0c040", x: 80, y: 980, animation: "fade", startTime: 1.0, endTime: 999,
      }));
      // gold accent line under title via color layer
      state.layers.push({
        ...newColorLayer({
          color: "#f0c040", opacity: 1,
          x: 80, y: 970, width: 360, height: 4,
          startTime: 0.6, endTime: 999,
        }),
      });
    } else if (name === "travel") {
      setAspect("16:9");
      state.effects.colorGrade = "teal_orange";
      state.layers.push(newTextLayer({
        text: "ESCAPE TO PARADISE",
        fontFamily: "Bebas Neue", fontWeight: 400, fontSize: 160,
        color: "#ffffff", x: 220, y: 460, animation: "reveal", startTime: 0.4, endTime: 999,
      }));
      state.layers.push(newTextLayer({
        text: "📍 Bali, Indonesia",
        fontFamily: "Syne", fontWeight: 500, fontSize: 44,
        color: "#ffffff", x: 760, y: 980, animation: "fade", startTime: 1.2, endTime: 999,
      }));
      // bottom gradient (approx with a color layer at bottom)
      state.layers.unshift(newColorLayer({
        color: "#000000", opacity: 0.35,
        x: 0, y: 800, width: 1920, height: 280, startTime: 0, endTime: 999,
      }));
    } else if (name === "social") {
      setAspect("9:16");
      state.effects.colorGrade = "moody_dark";
      state.effects.vignette = true;
      state.layers.push(newTextLayer({
        text: "HOOK THEM\nIN 3 SECONDS",
        fontFamily: "Bebas Neue", fontWeight: 400, fontSize: 140,
        color: "#ffffff", x: 80, y: 280, animation: "bounce", startTime: 0.2, endTime: 999,
      }));
      state.layers.push(newTextLayer({
        text: "#viral #fyp #motioncut",
        fontFamily: "JetBrains Mono", fontWeight: 600, fontSize: 38,
        color: "#f0c040", x: 80, y: 1700, animation: "fade", startTime: 0.5, endTime: 999,
      }));
    } else if (name === "corporate") {
      setAspect("16:9");
      state.effects.colorGrade = "natural";
      state.layers.push(newTextLayer({
        text: "ACME CORP",
        fontFamily: "Syne", fontWeight: 800, fontSize: 44,
        color: "#ffffff", x: 1480, y: 60, animation: "fade", startTime: 0, endTime: 999,
      }));
      state.layers.push(newTextLayer({
        text: "Building the future,\ntoday.",
        fontFamily: "Playfair Display", fontWeight: 700, fontSize: 96,
        color: "#ffffff", x: 100, y: 420, animation: "fade", startTime: 0.5, endTime: 999,
      }));
      state.layers.push(newColorLayer({
        color: "#f0c040", opacity: 1, x: 100, y: 660, width: 220, height: 3, startTime: 0.7, endTime: 999,
      }));
      state.layers.push(newTextLayer({
        text: "May 2026 · Quarterly Report",
        fontFamily: "JetBrains Mono", fontWeight: 400, fontSize: 28,
        color: "#9a9a9a", x: 100, y: 1000, animation: "fade", startTime: 0.8, endTime: 999,
      }));
    }
    syncEffectsUI();
    renderLayerList();
    renderLayerEditor();
    drawOverlay();
    snapshot();
  }

  // -------- Music & effects UI sync --------
  function syncEffectsUI() {
    $("fxVignette").checked = !!state.effects.vignette;
    $("fxGrain").checked = !!state.effects.filmGrain;
    $("fxLetterbox").checked = !!state.effects.letterbox;
    $("fxGrade").value = state.effects.colorGrade || "natural";
    $("aspectSel").value = state.aspect;
    applyVideoCSSFilter();
  }
  function syncMusicUI() {
    $("musicVolume").value = state.music.volume;
    $("musicFadeIn").checked = !!state.music.fadeIn;
    $("musicFadeOut").checked = !!state.music.fadeOut;
    $("musicReplace").checked = !!state.music.replace;
    $("musicInfo").textContent = state.music.name ? `🎵 ${state.music.name}` : "No music.";
  }

  // -------- Upload --------
  async function uploadFile(file, kind = "auto") {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("kind", kind);
    const r = await fetch("/api/upload", { method: "POST", body: fd });
    if (!r.ok) throw new Error((await r.json()).error || `upload failed ${r.status}`);
    return r.json();
  }

  function loadVideoFromInfo(info) {
    state.media = info;
    $("canvasEmpty").hidden = true;
    video.src = info.url;
    video.load();
    video.addEventListener("loadedmetadata", () => {
      $("scrubber").max = Math.max(1, Math.floor((video.duration || info.duration || 10) * 1000));
      $("mediaInfo").textContent = `${info.filename}  ·  ${info.width || "?"}×${info.height || "?"}  ·  ${(info.duration || video.duration || 0).toFixed(2)}s`;
      $("timeReadout").textContent = `${fmtTime(0)} / ${fmtTime(video.duration || 0)}`;
      layoutStage();
      drawOverlay();
    }, { once: true });
  }

  function bindUpload() {
    const dz = $("dropZone");
    const fi = $("fileInput");
    dz.addEventListener("click", () => fi.click());
    dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("dragover"); });
    dz.addEventListener("dragleave", () => dz.classList.remove("dragover"));
    dz.addEventListener("drop", async (e) => {
      e.preventDefault();
      dz.classList.remove("dragover");
      const f = e.dataTransfer.files[0];
      if (f) await handleMediaFile(f);
    });
    fi.addEventListener("change", async () => {
      if (fi.files[0]) await handleMediaFile(fi.files[0]);
    });
  }
  async function handleMediaFile(f) {
    try {
      const info = await uploadFile(f, "auto");
      if (info.kind === "video") {
        loadVideoFromInfo(info);
      } else if (info.kind === "image") {
        // treat as logo by default
        addLogoFromInfo(info);
      }
    } catch (e) {
      alert("Upload failed: " + e.message);
    }
  }

  function addLogoFromInfo(info) {
    const layer = newLogoLayer({
      src: info.url,
      x: 60, y: 60, width: 240, height: 240,
    });
    const img = new Image();
    img.onload = () => {
      const ratio = img.naturalWidth / img.naturalHeight || 1;
      layer.height = Math.round(layer.width / ratio);
      layer.img = img;
      drawOverlay();
    };
    img.src = info.url;
    layer.img = img;
    state.layers.push(layer);
    state.selectedId = layer.id;
    snapshot();
    renderLayerList();
    renderLayerEditor();
    drawOverlay();
  }

  function bindLogo() {
    $("logoInput").addEventListener("change", async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const info = await uploadFile(f, "image");
      addLogoFromInfo(info);
    });
    document.querySelectorAll("[data-logo-pos]").forEach((b) => {
      b.addEventListener("click", () => {
        const pos = b.getAttribute("data-logo-pos");
        const logo = state.layers.find((l) => l.type === "logo" && l.id === state.selectedId)
                    || state.layers.find((l) => l.type === "logo");
        if (!logo) return;
        const W = state.canvasWidth, H = state.canvasHeight;
        const m = 60;
        if (pos === "tl") { logo.x = m; logo.y = m; }
        if (pos === "tr") { logo.x = W - logo.width - m; logo.y = m; }
        if (pos === "bl") { logo.x = m; logo.y = H - logo.height - m; }
        if (pos === "br") { logo.x = W - logo.width - m; logo.y = H - logo.height - m; }
        if (pos === "c") { logo.x = (W - logo.width) / 2; logo.y = (H - logo.height) / 2; }
        snapshot();
        drawOverlay();
        renderLayerEditor();
      });
    });
    $("logoOpacity").addEventListener("input", (e) => {
      const logo = state.layers.find((l) => l.type === "logo");
      if (!logo) return;
      logo.opacity = Number(e.target.value);
      drawOverlay();
    });
    $("logoOpacity").addEventListener("change", snapshot);
    $("logoSize").addEventListener("input", (e) => {
      const logo = state.layers.find((l) => l.type === "logo");
      if (!logo) return;
      const ratio = (logo.width / logo.height) || 1;
      logo.width = Number(e.target.value);
      logo.height = Math.round(logo.width / ratio);
      drawOverlay();
    });
    $("logoSize").addEventListener("change", snapshot);
  }

  function bindMusic() {
    $("musicInput").addEventListener("change", async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        const info = await uploadFile(f, "audio");
        state.music.src = info.url;
        state.music.name = info.filename;
        syncMusicUI();
        snapshot();
      } catch (err) { alert("Upload failed: " + err.message); }
    });
    $("musicVolume").addEventListener("input", (e) => { state.music.volume = Number(e.target.value); });
    $("musicVolume").addEventListener("change", snapshot);
    $("musicFadeIn").addEventListener("change", () => { state.music.fadeIn = $("musicFadeIn").checked; snapshot(); });
    $("musicFadeOut").addEventListener("change", () => { state.music.fadeOut = $("musicFadeOut").checked; snapshot(); });
    $("musicReplace").addEventListener("change", () => { state.music.replace = $("musicReplace").checked; snapshot(); });
  }

  // -------- Effects --------
  function bindEffects() {
    $("fxVignette").addEventListener("change", (e) => { state.effects.vignette = e.target.checked; drawOverlay(); snapshot(); });
    $("fxGrain").addEventListener("change", (e) => { state.effects.filmGrain = e.target.checked; drawOverlay(); snapshot(); });
    $("fxLetterbox").addEventListener("change", (e) => { state.effects.letterbox = e.target.checked; drawOverlay(); snapshot(); });
    $("fxGrade").addEventListener("change", (e) => {
      state.effects.colorGrade = e.target.value;
      applyVideoCSSFilter();
      drawOverlay();
      snapshot();
    });
    $("aspectSel").addEventListener("change", (e) => { setAspect(e.target.value); snapshot(); });
  }

  // -------- Playback --------
  function bindPlayback() {
    const playBtn = $("playBtn");
    playBtn.addEventListener("click", () => {
      if (!video.src) return;
      if (video.paused) video.play(); else video.pause();
    });
    video.addEventListener("play", () => { playBtn.textContent = "❚❚ Pause"; pump(); });
    video.addEventListener("pause", () => { playBtn.textContent = "▶ Play"; });
    video.addEventListener("ended", () => { playBtn.textContent = "▶ Play"; });
    video.addEventListener("timeupdate", () => {
      $("timeReadout").textContent = `${fmtTime(video.currentTime)} / ${fmtTime(video.duration || 0)}`;
      $("scrubber").value = Math.floor((video.currentTime || 0) * 1000);
      drawOverlay();
    });
    $("scrubber").addEventListener("input", (e) => {
      if (!video.duration) return;
      const t = Number(e.target.value) / 1000;
      video.currentTime = clamp(t, 0, video.duration);
      drawOverlay();
    });
    let raf = 0;
    function pump() {
      if (video.paused || video.ended) { cancelAnimationFrame(raf); return; }
      drawOverlay();
      raf = requestAnimationFrame(pump);
    }
    if (state.music && state.music.src) {
      // music preview is best-effort: skipped for simplicity
    }
  }

  // -------- Keyboard --------
  function bindKeyboard() {
    window.addEventListener("keydown", (e) => {
      if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT")) return;
      if (e.code === "Space") {
        e.preventDefault();
        if (!video.src) return;
        if (video.paused) video.play(); else video.pause();
      } else if (e.code === "ArrowLeft") {
        if (video.duration) video.currentTime = Math.max(0, video.currentTime - 1 / 30);
      } else if (e.code === "ArrowRight") {
        if (video.duration) video.currentTime = Math.min(video.duration, video.currentTime + 1 / 30);
      } else if (e.code === "Delete" || e.code === "Backspace") {
        if (state.selectedId) deleteLayer(state.selectedId);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault(); undo();
      } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "y" || (e.shiftKey && e.key.toLowerCase() === "z"))) {
        e.preventDefault(); redo();
      }
    });
  }

  // -------- Save / Load Project --------
  function bindProjectIO() {
    $("saveProjectBtn").addEventListener("click", () => {
      const data = {
        version: 1,
        media: state.media,
        layers: state.layers.map((l) => { const c = { ...l }; delete c.img; return c; }),
        effects: state.effects,
        music: state.music,
        template: state.template,
        aspect: state.aspect,
      };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "motioncut_project.json";
      a.click();
    });
    $("loadProjectInput").addEventListener("change", async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const text = await f.text();
      try {
        const obj = JSON.parse(text);
        state.historyMuted = true;
        if (obj.aspect) setAspect(obj.aspect);
        state.layers = obj.layers || [];
        state.effects = obj.effects || state.effects;
        state.music = obj.music || state.music;
        state.template = obj.template || "custom";
        // re-load logo images
        for (const l of state.layers) {
          if (l.type === "logo" && l.src) {
            const img = new Image(); img.src = l.src; l.img = img;
            img.onload = drawOverlay;
          }
        }
        if (obj.media && obj.media.url) loadVideoFromInfo(obj.media);
        syncEffectsUI();
        syncMusicUI();
        renderLayerList();
        renderLayerEditor();
        drawOverlay();
      } catch (err) {
        alert("Could not load project: " + err.message);
      } finally {
        state.historyMuted = false;
        snapshot();
      }
    });
  }

  // -------- Export --------
  function buildExportPayload(aspect) {
    if (!state.media || !state.media.url) {
      alert("Please upload a video first.");
      return null;
    }
    return {
      videoUrl: state.media.url,
      aspect,
      template: state.template,
      duration: video.duration || state.media.duration || 10,
      canvasWidth: state.canvasWidth,
      canvasHeight: state.canvasHeight,
      fit: aspect === state.aspect ? "cover" : "contain",
      effects: state.effects,
      music: state.music && state.music.src ? state.music : null,
      layers: state.layers.map((l) => {
        const o = { ...l };
        delete o.img;
        return o;
      }),
    };
  }

  async function startExport(aspect) {
    const payload = buildExportPayload(aspect);
    if (!payload) return;
    $("exportProgressWrap").hidden = false;
    $("exportProgress").style.width = "2%";
    $("exportStatus").textContent = "Submitting…";
    $("exportLink").hidden = true;
    $("exportLink").innerHTML = "";
    try {
      const r = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `export failed ${r.status}`);
      pollExport(j.jobId);
    } catch (e) {
      $("exportStatus").textContent = "Error: " + e.message;
    }
  }
  async function pollExport(jobId) {
    $("exportStatus").textContent = "Rendering…";
    while (true) {
      await new Promise((r) => setTimeout(r, 1000));
      const r = await fetch(`/api/export/status/${jobId}`);
      const j = await r.json();
      if (!r.ok) { $("exportStatus").textContent = "Error: " + (j.error || r.status); return; }
      const pct = Math.round((j.progress || 0) * 100);
      $("exportProgress").style.width = pct + "%";
      $("exportStatus").textContent = `Rendering… ${pct}%`;
      if (j.status === "done") {
        $("exportProgress").style.width = "100%";
        $("exportStatus").textContent = "Done.";
        const link = j.url;
        $("exportLink").hidden = false;
        $("exportLink").innerHTML = `
          <a class="btn primary block" href="${link}" download>⬇ Download ${j.output}</a>
          <video src="${link}" controls style="width:100%;margin-top:.5rem;border-radius:8px;"></video>
        `;
        return;
      }
      if (j.status === "error") {
        $("exportStatus").textContent = "Error: " + (j.error || "render failed");
        return;
      }
    }
  }

  function bindExport() {
    $("export169").addEventListener("click", () => startExport("16:9"));
    $("export916").addEventListener("click", () => startExport("9:16"));
  }

  // -------- Init --------
  function init() {
    video = $("video");
    canvas = $("overlay");
    ctx = canvas.getContext("2d");
    overlayWrap = $("canvasWrap");

    setAspect("16:9");
    bindCanvasEvents();
    bindUpload();
    bindLogo();
    bindMusic();
    bindEffects();
    bindPlayback();
    bindKeyboard();
    bindProjectIO();
    bindExport();

    $("addTextBtn").addEventListener("click", () => {
      const l = newTextLayer({ text: "New Text", x: 200, y: 200 });
      state.layers.push(l);
      state.selectedId = l.id;
      snapshot();
      renderLayerList();
      renderLayerEditor();
      drawOverlay();
    });

    document.querySelectorAll(".tpl").forEach((b) => {
      b.addEventListener("click", () => applyTemplate(b.getAttribute("data-tpl")));
    });

    $("undoBtn").addEventListener("click", undo);
    $("redoBtn").addEventListener("click", redo);

    window.addEventListener("resize", () => { layoutStage(); drawOverlay(); });

    syncEffectsUI();
    syncMusicUI();
    renderLayerList();
    renderLayerEditor();
    drawOverlay();
    snapshot();

    fetch("/api/health").then((r) => r.json()).then((j) => {
      if (!j.ffmpeg) {
        $("exportStatus").textContent = "FFmpeg not detected. Install with: winget install FFmpeg";
        $("exportProgressWrap").hidden = false;
      }
    }).catch(() => {});
  }

  document.addEventListener("DOMContentLoaded", init);
})();
