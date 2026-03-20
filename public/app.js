(function () {
  // Browser-only app: document/window don't exist in Node.js
  if (typeof document === "undefined" || typeof window === "undefined") {
    console.error(
      "This app runs in the browser. Open index.html in a browser, or run:\n  npx serve .\n  and visit http://localhost:3000",
    );
    return;
  }

  const ZOOM_THRESHOLD = 100; // identifiers unlock, seats exposed when zoom > 100%
  const MIN_ZOOM = 1; // 100% minimum (fit to screen)
  const MAX_ZOOM = 16; // 300% with exponent 2 = 2^4 = 16x scale
  const ZOOM_EXP = 2.0; // scale = 2^((zoomLevel-100)/100 * ZOOM_EXP) per 100%
  const ZOOM_ANIMATION_DURATION = 220; // ms for smooth zoom in/out
  const INITIAL_ZOOM_PCT = 170; // 100% on open = same as current 170% view

  let svgDoc = null;
  let identifierElements = [];
  let sectionPaths = []; // { el, sectionId } for click-to-zoom
  let gaSectionIds = new Set(); // NZ/GA section ids from SVG (sec-X NZ, no seats) — keep identifiers visible when zoomed in
  let zoomLevel = 100;
  let scale = 1;
  let referenceScale = 1; // 100% = fitted to screen; set on initial fit and on resize
  let panX = 0,
    panY = 0;
  let viewBoxX = 0,
    viewBoxY = 0;
  let zoomAnimationId = null;
  let animateInitialFit = false;
  let mode = "seat";
  let seatData = { sections: {}, total: 0, bySecRow: {} };
  let isPanning = false;
  let lastMouseX = 0,
    lastMouseY = 0;
  let vb = { x: 0, y: 0, w: 3000, h: 2250 };
  const fileInput = document.getElementById("fileInput");
  const uploadScreen = document.getElementById("uploadScreen");
  const mapScreen = document.getElementById("mapScreen");
  const svgWrapper = document.getElementById("svgWrapper");
  const svgTransformWrap = document.getElementById("svgTransformWrap");
  const mapContainer = document.getElementById("mapContainer");
  const zoomDisplay = document.getElementById("zoomDisplay");
  const zoomInBtn = document.getElementById("zoomIn");
  const zoomOutBtn = document.getElementById("zoomOut");
  const popover = document.getElementById("popover");
  const popSec = document.getElementById("popSec");
  const popRow = document.getElementById("popRow");
  const popSeat = document.getElementById("popSeat");
  const popRowWrap = document.getElementById("popRowWrap");
  const popRowLabel = document.getElementById("popRowLabel");
  const popLastLabel = document.getElementById("popLastLabel");
  const totalSeatsEl = document.getElementById("totalSeats");
  const sectionsListEl = document.getElementById("sectionsList");
  const popoverAccessibleEl = document.getElementById("popoverAccessible");
  const popoverAccessibleLabel = document.getElementById(
    "popoverAccessibleLabel",
  );
  const nzModal = document.getElementById("nzModal");
  const nzForm = document.getElementById("nzForm");
  const nzInputs = document.getElementById("nzInputs");

  fileInput.addEventListener("change", handleFile);
  window.addEventListener("resize", scheduleFitWhenReady);
  zoomInBtn.addEventListener("click", () => zoomAtCenter(1.2));
  zoomOutBtn.addEventListener("click", () => zoomAtCenter(1 / 1.2));

  // ResizeObserver: refit when container size changes so map scales with screen
  let resizeDebounce = null;
  function scheduleFitWhenReady() {
    if (!mapContainer || !svgDoc || mapScreen.classList.contains("hidden"))
      return;
    clearTimeout(resizeDebounce);
    resizeDebounce = setTimeout(() => {
      const rect = mapContainer.getBoundingClientRect();
      if (rect.width >= MIN_CONTAINER_SIZE && rect.height >= MIN_CONTAINER_SIZE)
        fitMapToView();
    }, 50);
  }
  let mapResizeObserver = null;
  if (mapContainer && typeof ResizeObserver !== "undefined") {
    mapResizeObserver = new ResizeObserver(scheduleFitWhenReady);
  }

  // Wheel zoom (trackpad pinch or Ctrl+scroll)
  if (mapContainer) {
    mapContainer.addEventListener("wheel", onWheel, { passive: false });
    mapContainer.addEventListener("mousedown", onPanStart);
  }
  document.addEventListener("mousemove", onPanMove);
  document.addEventListener("mouseup", onPanEnd);
  document.addEventListener("mouseleave", onPanEnd);

  const toolButtons = Array.from(document.querySelectorAll(".tool-btn"));
  toolButtons.forEach((btn) => {
    btn.addEventListener("click", () => setMode(btn.dataset.mode));
  });
  setMode("section");
  function setMode(newMode) {
    if (!newMode || mode === newMode) return;
    mode = newMode;
    toolButtons.forEach((btn) =>
      btn.classList.toggle("active", btn.dataset.mode === newMode),
    );
    hidePopover();
    clearHighlights();
    updateSectionCoverPointerEvents();
    updateSeatPointerEvents();
  }

  function onWheel(e) {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const rect = mapContainer.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const factor = e.deltaY > 0 ? 1 / 1.1 : 1.1;
      zoomAtPoint(cx, cy, factor);
    } else {
      e.preventDefault();
      const rect = mapContainer.getBoundingClientRect();
      const viewW = getViewW(),
        viewH = getViewH();
      viewBoxX += e.deltaX * (viewW / rect.width);
      viewBoxY += e.deltaY * (viewH / rect.height);
      panX -= e.deltaX;
      panY -= e.deltaY;
      applyTransform();
    }
  }

  function onPanStart(e) {
    if (
      e.target.closest("rect[data-sec]") ||
      e.target.closest("[data-section-id]") ||
      e.target.closest(".zoom-controls")
    )
      return;
    isPanning = true;
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
    mapContainer.style.cursor = "grabbing";
    document.body.style.userSelect = "none";
  }

  function onPanMove(e) {
    if (!isPanning) return;
    const rect = mapContainer.getBoundingClientRect();
    const dx = e.clientX - lastMouseX;
    const dy = e.clientY - lastMouseY;
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
    const viewW = getViewW(),
      viewH = getViewH();
    viewBoxX -= dx * (viewW / rect.width);
    viewBoxY -= dy * (viewH / rect.height);
    panX += dx;
    panY += dy;
    applyTransform();
  }

  function onPanEnd() {
    if (isPanning) {
      isPanning = false;
      mapContainer.style.cursor = "grab";
      document.body.style.userSelect = "";
    }
  }

  function zoomAtPoint(containerX, containerY, factor) {
    if (zoomAnimationId) {
      cancelAnimationFrame(zoomAnimationId);
      zoomAnimationId = null;
    }
    const rect = mapContainer.getBoundingClientRect();
    const viewW = getViewW(),
      viewH = getViewH();
    const svgX = viewBoxX + (containerX / rect.width) * viewW;
    const svgY = viewBoxY + (containerY / rect.height) * viewH;
    const newScale = Math.max(
      referenceScale * MIN_ZOOM,
      Math.min(referenceScale * MAX_ZOOM, scale * factor),
    );
    const newViewW = vb.w / newScale;
    const newViewH = vb.h / newScale;
    viewBoxX = svgX - (containerX / rect.width) * newViewW;
    viewBoxY = svgY - (containerY / rect.height) * newViewH;
    scale = newScale;
    zoomLevel = scaleToZoomLevel(scale);
    zoomDisplay.textContent = zoomLevel + "%";
    applyTransform();
    applyIdentifierStyle();
    updateZoomClass();
  }

  function getViewW() {
    return vb.w / scale;
  }
  function getViewH() {
    return vb.h / scale;
  }

  // Exponent 2.0 per 100%: 100%→1x, 200%→4x, 300%→16x (max 300%)
  function scaleToZoomLevel(s) {
    const ratio = Math.max(0, s / referenceScale);
    const pct = 100 + (100 / ZOOM_EXP) * Math.log2(ratio);
    return Math.round(Math.max(100, Math.min(300, pct)));
  }

  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  function animateZoomTo(targetScale, targetViewBoxX, targetViewBoxY) {
    if (zoomAnimationId) cancelAnimationFrame(zoomAnimationId);
    const startScale = scale;
    const startVbx = viewBoxX;
    const startVby = viewBoxY;
    const startTime = performance.now();
    function tick(now) {
      const elapsed = now - startTime;
      const t = Math.min(1, elapsed / ZOOM_ANIMATION_DURATION);
      const eased = easeOutCubic(t);
      scale = startScale + (targetScale - startScale) * eased;
      viewBoxX = startVbx + (targetViewBoxX - startVbx) * eased;
      viewBoxY = startVby + (targetViewBoxY - startVby) * eased;
      zoomLevel = scaleToZoomLevel(scale);
      zoomDisplay.textContent = zoomLevel + "%";
      applyTransform();
      applyIdentifierStyle();
      updateZoomClass();
      if (t < 1) zoomAnimationId = requestAnimationFrame(tick);
      else zoomAnimationId = null;
    }
    zoomAnimationId = requestAnimationFrame(tick);
  }

  function updateZoomClass() {
    if (mapContainer) {
      mapContainer.classList.toggle("zoom-in", zoomLevel > ZOOM_THRESHOLD);
    }
    updateSectionCoverPointerEvents();
    updateSeatPointerEvents();
  }

  function updateSeatPointerEvents() {
    const seatsExposed = zoomLevel > ZOOM_THRESHOLD;
    svgDoc?.querySelectorAll("rect[data-sec]").forEach((r) => {
      r.style.pointerEvents = seatsExposed ? "auto" : "none";
    });
  }

  function updateSectionCoverPointerEvents() {
    const zoomedOut = zoomLevel <= ZOOM_THRESHOLD;
    sectionPaths.forEach(({ el, sectionId }) => {
      const gaStaysInteractive = sectionId && gaSectionIds.has(sectionId);
      const visible = zoomedOut || gaStaysInteractive;
      el.style.pointerEvents = visible && mode === "section" ? "auto" : "none";
    });
  }

  function zoomAtCenter(factor) {
    const rect =
      svgTransformWrap && svgTransformWrap.getBoundingClientRect().width > 0
        ? svgTransformWrap.getBoundingClientRect()
        : mapContainer.getBoundingClientRect();
    const containerRect = mapContainer.getBoundingClientRect();
    const cx = rect.left - containerRect.left + rect.width / 2;
    const cy = rect.top - containerRect.top + rect.height / 2;
    const viewW = getViewW(),
      viewH = getViewH();
    const svgX = viewBoxX + (cx / rect.width) * viewW;
    const svgY = viewBoxY + (cy / rect.height) * viewH;
    const newScale = Math.max(
      referenceScale * MIN_ZOOM,
      Math.min(referenceScale * MAX_ZOOM, scale * factor),
    );
    const newViewW = vb.w / newScale;
    const newViewH = vb.h / newScale;
    const targetVbx = svgX - (cx / rect.width) * newViewW;
    const targetVby = svgY - (cy / rect.height) * newViewH;
    animateZoomTo(newScale, targetVbx, targetVby);
  }

  function zoomToSection(sectionId) {
    const seats = svgDoc.querySelectorAll(`rect[data-sec="${sectionId}"]`);
    if (!seats.length) return;
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    seats.forEach((r) => {
      const b = r.getBBox();
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.width);
      maxY = Math.max(maxY, b.y + b.height);
    });
    const bw = maxX - minX,
      bh = maxY - minY;
    const rect = mapContainer.getBoundingClientRect();
    const pad = 24;
    const targetW = rect.width - pad * 2;
    const targetH = rect.height - pad * 2;
    const s = Math.min(targetW / bw, targetH / bh, referenceScale * 2);
    let newScale = Math.max(
      referenceScale * MIN_ZOOM,
      Math.min(referenceScale * MAX_ZOOM, Math.max(referenceScale, s)),
    );
    if (newScale <= referenceScale) newScale = referenceScale * 1.25;
    const viewW = vb.w / newScale;
    const viewH = vb.h / newScale;
    const cx = (minX + maxX) / 2,
      cy = (minY + maxY) / 2;
    const minVbx = 0;
    const minVby = 0;
    const maxVbx = vb.w - viewW;
    const maxVby = vb.h - viewH;
    const targetVbx = Math.max(minVbx, Math.min(maxVbx, cx - viewW / 2));
    const targetVby = Math.max(minVby, Math.min(maxVby, cy - viewH / 2));
    animateZoomTo(newScale, targetVbx, targetVby);
  }

  function applyTransform() {
    if (!svgDoc || !svgTransformWrap) return;
    const viewW = vb.w / scale;
    const viewH = vb.h / scale;
    if (scale >= 1) {
      viewBoxX = Math.max(0, Math.min(vb.w - viewW, viewBoxX));
      viewBoxY = Math.max(0, Math.min(vb.h - viewH, viewBoxY));
    } else {
      viewBoxX = Math.max(vb.w * (1 - 1 / scale), Math.min(0, viewBoxX));
      viewBoxY = Math.max(vb.h * (1 - 1 / scale), Math.min(0, viewBoxY));
    }
    svgDoc.setAttribute("viewBox", `${viewBoxX} ${viewBoxY} ${viewW} ${viewH}`);
    svgDoc.setAttribute("preserveAspectRatio", "xMidYMid meet");
    svgDoc.style.width = "100%";
    svgDoc.style.height = "100%";
    svgTransformWrap.style.transform = "none";
    svgTransformWrap.style.width = "100%";
    svgTransformWrap.style.height = "100%";
  }

  function handleFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    const name = (file.name || "").toLowerCase();
    const isSvg = name.endsWith(".svg");
    const isProject = name.endsWith(".svgqc") || name.endsWith(".json");
    if (!isSvg && !isProject) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target.result;
      if (isSvg) {
        loadSvg(text);
      } else {
        try {
          const project = JSON.parse(text);
          if (
            project &&
            typeof project.svg === "string" &&
            project.capacities &&
            typeof project.capacities === "object"
          ) {
            loadSvg(project.svg, project.capacities);
          } else {
            loadSvg(text);
          }
        } catch (_) {
          loadSvg(text);
        }
      }
      uploadScreen.classList.add("hidden");
      mapScreen.classList.remove("hidden");
    };
    reader.readAsText(file);
  }

  // Find NZ sections: <g class="sec-P NZ"> etc. — sec-X with NZ, no rows/seats inside
  function findNzSections(svg) {
    const nzSectionIds = new Set();
    const walk = (el) => {
      if (!el || el.nodeType !== 1) return;
      const cls = String(
        (el.className && (el.className.baseVal || el.className)) || "",
      ).trim();
      const hasNz = /nz/i.test(cls);
      const secMatch = cls.match(/\bsec-([^-]+)\b/i);
      if (hasNz && secMatch) {
        const secId = secMatch[1];
        // Must not have rows and seats inside (no rect with seat classes)
        const hasSeats =
          el.querySelector &&
          el.querySelector('rect[class*="-row-"][class*="-seat-"]');
        if (!hasSeats) nzSectionIds.add(secId);
      }
      Array.from(el.children || []).forEach(walk);
    };
    walk(svg);
    return Array.from(nzSectionIds).sort((a, b) =>
      String(a).localeCompare(b, undefined, { numeric: true }),
    );
  }

  function showNzCapacityModal(nzSections) {
    nzInputs.innerHTML = nzSections
      .map(
        (sec) =>
          `<div class="input-row"><label for="nz-${sec}">Add seats for Section ${formatSectionDisplayName(sec)} (GA)</label><input type="number" id="nz-${sec}" name="${sec}" min="0" placeholder="0" inputmode="numeric"></div>`,
      )
      .join("");
    nzModal.classList.remove("hidden");
  }

  function hideNzModal() {
    nzModal.classList.add("hidden");
  }

  function handleNzSubmit(e) {
    e.preventDefault();
    if (!nzForm) return;
    const nzSectionIds = Array.from(
      nzInputs.querySelectorAll("input[name]"),
    ).map((inp) => inp.name);
    nzSectionIds.forEach((sec) => {
      const inp = nzForm.querySelector(`input[name="${sec}"]`);
      const n = inp ? parseInt(inp.value, 10) : 0;
      const val = isNaN(n) || n < 0 ? 0 : n;
      seatData.sections[sec] = (seatData.sections[sec] || 0) + val;
      seatData.total += val;
    });
    renderPanel();
    hideNzModal();
  }

  if (nzForm) nzForm.addEventListener("submit", handleNzSubmit);

  const exportProjectBtn = document.getElementById("exportProjectBtn");
  function exportProject() {
    if (!svgDoc || !svgWrapper) return;
    const project = {
      version: 1,
      svg: svgWrapper.innerHTML,
      capacities: { ...seatData.sections },
    };
    const blob = new Blob([JSON.stringify(project)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "map.svgqc";
    a.click();
    URL.revokeObjectURL(a.href);
  }
  if (exportProjectBtn)
    exportProjectBtn.addEventListener("click", exportProject);

  function loadSvg(svgString, initialCapacities) {
    svgWrapper.innerHTML = svgString;
    svgDoc = svgWrapper.querySelector("svg");
    if (!svgDoc) return;
    const vbStr = svgDoc.getAttribute("viewBox");
    if (vbStr) {
      const [x, y, w, h] = vbStr.split(/\s+/).map(Number);
      vb = { x, y, w, h };
    }
    svgDoc.setAttribute("width", "100%");
    svgDoc.setAttribute("height", "100%");

    seatData = { sections: {}, total: 0, bySecRow: {} };
    // Find NZ/GA sections first so they're in sectionIds for section cover detection
    const nzSections = findNzSections(svgDoc);
    gaSectionIds = new Set(nzSections);
    nzSections.forEach((sec) => {
      seatData.sections[sec] = 0;
    });

    // Wheelchair icon: viewBox 0 0 173 173, center at (86.5, 86.5)
    const WHEELCHAIR_PATH =
      "M68.1915 39.4879C75.1643 39.4879 80.7744 33.8198 80.7744 26.992C80.7744 20.0627 75.1643 14.4961 68.1915 14.4961C61.2477 14.4961 55.6086 20.0627 55.6086 26.992C55.6086 33.8198 61.2477 39.4879 68.1915 39.4879ZM142.036 124.973L120.582 88.1959C119.248 85.9779 116.914 84.7312 114.493 84.6588L83.0068 84.6588L82.6879 73.598L105.549 73.598C108.665 73.4095 111.231 71.0611 111.231 67.8864C111.231 64.7552 108.738 62.3198 105.549 62.2183L82.0501 62.2183L81.2383 53.1146C80.7744 46.5622 75.0918 41.4015 68.4234 41.7639C61.6971 42.1408 56.6233 47.8814 56.9423 54.5207L59.1602 92.4433C59.7111 99.0972 65.3067 103.809 71.9461 103.809L112.753 103.809L129.424 132.468C131.425 135.715 136.049 137.049 139.528 134.976C142.964 132.888 143.993 128.597 142.036 124.973ZM76.2805 146.732C55.6376 146.732 38.8942 130.149 38.8942 109.622C38.8942 98.3869 44.026 88.3554 52.0135 81.5275L51.3177 69.9304C37.952 78.2224 28.9932 92.7913 28.9932 109.622C28.9932 135.541 50.1434 156.576 76.2805 156.576C95.5172 156.576 111.956 145.08 119.349 128.728L112.71 117.276C109.144 134.048 94.2415 146.732 76.2805 146.732Z";
    const WHEELCHAIR_VIEWBOX = 173;
    const WHEELCHAIR_CENTER = 86.5;
    const seats = svgDoc.querySelectorAll(
      'rect[class*="-row-"][class*="-seat-"]',
    );
    seats.forEach((rect) => {
      const cls =
        (rect.className && (rect.className.baseVal || rect.className)) || "";
      const m = cls.match(/sec-([^-]+)-row-([^-]+)-seat-(\d+)/);
      if (m) {
        const [_, sec, row, seat] = m;
        seatData.total++;
        seatData.sections[sec] = (seatData.sections[sec] || 0) + 1;
        if (!seatData.bySecRow[sec]) seatData.bySecRow[sec] = {};
        if (!seatData.bySecRow[sec][row]) seatData.bySecRow[sec][row] = 0;
        seatData.bySecRow[sec][row]++;
        rect.dataset.sec = sec;
        rect.dataset.row = row;
        rect.dataset.seat = seat;
        const secU = String(sec).toUpperCase();
        const rowU = String(row).toUpperCase();
        const isDA =
          secU === "DA" || rowU === "DA" || /da|accessible/i.test(cls);
        const isDB = secU === "DB" || rowU === "DB" || /db/i.test(cls);
        const isAccessible = isDA || isDB;
        if (isAccessible) {
          rect.dataset.accessible = "true";
          rect.dataset.accessibleType = isDA ? "DA" : "DB"; // DA = open space, DB = chairback
          rect.setAttribute("fill", isDA ? "#2DEDB4" : "#F4BC16"); // DA = teal, DB = yellow
          rect.classList.add("seat-accessible");
        }
        rect.style.cursor = "pointer";
        rect.addEventListener("mouseenter", onSeatEnter);
        rect.addEventListener("mouseleave", onSeatLeave);
      }
    });

    // Add wheelchair icons to accessible seats after layout (so position/size are correct)
    function addWheelchairIcons() {
      const accessibleRects = svgDoc.querySelectorAll("rect.seat-accessible");
      accessibleRects.forEach((rect) => {
        const parent = rect.parentNode;
        if (!parent || !parent.insertBefore) return;
        const x = parseFloat(rect.getAttribute("x"));
        const y = parseFloat(rect.getAttribute("y"));
        const w = parseFloat(rect.getAttribute("width"));
        const h = parseFloat(rect.getAttribute("height"));
        let cx, cy, size;
        if (
          Number.isFinite(x) &&
          Number.isFinite(y) &&
          Number.isFinite(w) &&
          Number.isFinite(h) &&
          w > 0 &&
          h > 0
        ) {
          cx = x + w / 2;
          cy = y + h / 2;
          size = 0.75 * Math.min(w, h);
        } else {
          const bbox = rect.getBBox();
          cx = bbox.x + bbox.width / 2;
          cy = bbox.y + bbox.height / 2;
          size = 0.75 * Math.min(bbox.width, bbox.height);
        }
        if (size <= 0) return;
        const scale = size / WHEELCHAIR_VIEWBOX;
        const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
        g.setAttribute("class", "seat-wheelchair-icon");
        g.setAttribute(
          "transform",
          `translate(${cx},${cy}) scale(${scale}) translate(${-WHEELCHAIR_CENTER},${-WHEELCHAIR_CENTER})`,
        );
        g.setAttribute("pointer-events", "none");
        const path = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "path",
        );
        path.setAttribute("d", WHEELCHAIR_PATH);
        path.setAttribute("fill", "#141416");
        g.appendChild(path);
        parent.insertBefore(g, rect.nextSibling);
      });
    }
    if (!initialCapacities) {
      requestAnimationFrame(() => addWheelchairIcons());
    }

    identifierElements = [];
    sectionPaths = [];
    const sectionIds = new Set([
      ...Object.keys(seatData.sections),
      "mf1",
      "mf2",
      "MF1",
      "MF2",
    ]);
    const sectionPattern = /^(?:mf[12]|\d+)$/i;
    const seatRects = svgDoc.querySelectorAll("rect[data-sec]");
    svgDoc
      .querySelectorAll("path[class], polygon[class], rect[class], g[class]")
      .forEach((el) => {
        // Never treat elements inside the base group as section identifiers (e.g. GATE 1–4 paths/labels)
        if (el.closest && el.closest('g[class*="base"]')) return;
        const tag = (el.tagName && el.tagName.toLowerCase()) || "";
        if (tag === "rect" && el.hasAttribute("data-sec")) return;
        if (tag === "g") {
          const hasSeatChild = el.querySelector("rect[data-sec]");
          if (hasSeatChild) return;
        }
        const cls = String(
          (el.className && (el.className.baseVal || el.className)) || "",
        ).trim();
        if (!cls) return;
        const tokens = cls.split(/\s+/);
        const hasSecMatch = tokens.some((t) => {
          const m = t.match(/^sec-([^-]+)$/i);
          return m && sectionIds.has(m[1]);
        });
        const isSectionCover =
          (hasSecMatch ||
            tokens.some((t) => sectionIds.has(t) || sectionPattern.test(t))) &&
          !cls.includes("-seat-") &&
          !cls.includes("-row-");
        if (!isSectionCover) return;
        if (tag === "g" && el.querySelector("rect[data-sec]")) return; // g with seat rects: use children, not g itself
        const stroke = el.getAttribute && el.getAttribute("stroke");
        const fillRaw = ((el.getAttribute && el.getAttribute("fill")) || "")
          .trim()
          .toLowerCase();
        const isTransparentFill =
          !fillRaw || fillRaw === "none" || fillRaw === "transparent";
        const isWhiteFill =
          fillRaw === "#fff" || fillRaw === "#ffffff" || fillRaw === "white";
        const hasVisibleFill = !isTransparentFill && !isWhiteFill;
        const isSeparatorLine =
          (isTransparentFill || isWhiteFill) && stroke && stroke !== "none";
        if (isSeparatorLine) return;
        identifierElements.push(el);
        let secId = tokens.find(
          (t) => sectionIds.has(t) || sectionPattern.test(t),
        );
        if (!secId) {
          const m = tokens.find((t) => /^sec-([^-]+)$/i.test(t));
          if (m) secId = m.match(/^sec-([^-]+)$/i)[1];
        }
        if (secId && sectionIds.has(secId)) {
          el.dataset.sectionId = secId;
          el.style.cursor = "pointer";
          el.addEventListener("click", (e) => {
            e.stopPropagation();
            zoomToSection(secId);
          });
          el.addEventListener("mouseenter", (e) =>
            onSectionPathEnter(e, secId),
          );
          el.addEventListener("mouseleave", onSectionPathLeave);
          sectionPaths.push({ el, sectionId: secId });
        }
      });

    // GA sections: attach hover/click to all descendants of sec-X NZ groups so popover triggers when hovering any part
    gaSectionIds.forEach((gaSecId) => {
      const gaGroups = svgDoc.querySelectorAll('g[class*="sec-"]');
      gaGroups.forEach((g) => {
        const cls = String(
          (g.className && (g.className.baseVal || g.className)) || "",
        );
        if (!/nz/i.test(cls)) return;
        const m = cls.match(/\bsec-([^-]+)\b/i);
        if (!m || m[1] !== gaSecId) return;
        g.querySelectorAll("path, polygon, rect, g").forEach((desc) => {
          if (desc.closest('g[class*="base"]')) return;
          if (desc.dataset.sectionId === gaSecId) return; // already has listener
          desc.style.cursor = "pointer";
          desc.addEventListener("click", (e) => {
            e.stopPropagation();
            zoomToSection(gaSecId);
          });
          desc.addEventListener("mouseenter", (e) =>
            onSectionPathEnter(e, gaSecId),
          );
          desc.addEventListener("mouseleave", onSectionPathLeave);
        });
      });
    });

    if (initialCapacities && typeof initialCapacities === "object") {
      Object.keys(initialCapacities).forEach((sec) => {
        const n = Number(initialCapacities[sec]);
        if (!isNaN(n) && n >= 0) seatData.sections[sec] = n;
      });
      seatData.total = Object.values(seatData.sections).reduce(
        (a, b) => a + b,
        0,
      );
    }
    if (nzSections.length > 0 && !initialCapacities)
      showNzCapacityModal(nzSections);

    renderPanel();
    applyIdentifierStyle();
    hidePopover();
    updateSectionCoverPointerEvents();
    updateSeatPointerEvents();
    animateInitialFit = true;
    if (mapResizeObserver) mapResizeObserver.observe(mapContainer);
    requestAnimationFrame(() => {
      const rect = mapContainer.getBoundingClientRect();
      if (rect.width >= MIN_CONTAINER_SIZE && rect.height >= MIN_CONTAINER_SIZE)
        fitMapToView();
    });
  }

  const MIN_CONTAINER_SIZE = 50; // avoid fitting to partially laid-out container (prevents "small then jump")
  function fitMapToView() {
    if (!mapContainer || !svgDoc) return;
    // Use the actual SVG area (inset by CSS) so fit and centering match the visible frame
    const rect =
      svgTransformWrap && svgTransformWrap.getBoundingClientRect().width > 0
        ? svgTransformWrap.getBoundingClientRect()
        : mapContainer.getBoundingClientRect();
    if (rect.width < MIN_CONTAINER_SIZE || rect.height < MIN_CONTAINER_SIZE)
      return;

    // Fit horizontally: fill container width; 100% = same as INITIAL_ZOOM_PCT (e.g. 169%) so map is larger on open
    const fitScale = rect.width / vb.w;
    referenceScale =
      fitScale * Math.pow(2, ((INITIAL_ZOOM_PCT - 100) / 100) * ZOOM_EXP);
    const initialScale = referenceScale;
    scale = Math.max(
      referenceScale * MIN_ZOOM,
      Math.min(referenceScale * MAX_ZOOM, initialScale),
    );
    viewBoxX = scale >= 1 ? 0 : (vb.w * (1 - 1 / scale)) / 2;
    viewBoxY = scale >= 1 ? 0 : (vb.h * (1 - 1 / scale)) / 2;

    if (animateInitialFit) {
      animateInitialFit = false;
      const targetScale = Math.max(
        referenceScale * MIN_ZOOM,
        Math.min(referenceScale * MAX_ZOOM, initialScale),
      );
      const targetVbx =
        targetScale >= 1 ? 0 : (vb.w * (1 - 1 / targetScale)) / 2;
      const targetVby =
        targetScale >= 1 ? 0 : (vb.h * (1 - 1 / targetScale)) / 2;
      scale = targetScale * 0.98;
      viewBoxX = scale >= 1 ? 0 : (vb.w * (1 - 1 / scale)) / 2;
      viewBoxY = scale >= 1 ? 0 : (vb.h * (1 - 1 / scale)) / 2;
      panX = 0;
      panY = 0;
      applyTransform();
      zoomLevel = scaleToZoomLevel(scale);
      zoomDisplay.textContent = zoomLevel + "%";
      applyIdentifierStyle();
      updateZoomClass();
      animateZoomTo(targetScale, targetVbx, targetVby);
      return;
    }

    scale = Math.max(
      referenceScale * MIN_ZOOM,
      Math.min(referenceScale * MAX_ZOOM, initialScale),
    );
    zoomLevel = scaleToZoomLevel(scale);
    if (scale >= 1) {
      viewBoxX = 0;
      viewBoxY = 0;
    } else {
      viewBoxX = (vb.w * (1 - 1 / scale)) / 2;
      viewBoxY = (vb.h * (1 - 1 / scale)) / 2;
    }
    panX = 0;
    panY = 0;
    zoomDisplay.textContent = zoomLevel + "%";
    applyTransform();
    applyIdentifierStyle();
    updateZoomClass();
  }

  function renderPanel() {
    totalSeatsEl.textContent = seatData.total.toLocaleString();
    const sorted = Object.entries(seatData.sections).sort((a, b) =>
      String(a[0]).localeCompare(b[0], undefined, { numeric: true }),
    );
    sectionsListEl.innerHTML = sorted
      .map(
        ([sec, count]) =>
          `<div class="section-item" data-sec="${sec}"><span class="sec-name">Section ${formatSectionDisplayName(sec)}</span><span class="sec-count">${count} seats</span></div>`,
      )
      .join("");
    sectionsListEl.querySelectorAll(".section-item").forEach((item) => {
      item.style.cursor = "pointer";
      item.addEventListener("click", () => zoomToSection(item.dataset.sec));
    });
  }

  // True if el is inside a group with class like "sec-X NZ" where X is in gaSectionIds (does not rely on data-section-id)
  function isInsideNzSection(el) {
    let node = el && el.parentNode;
    while (node && node.nodeType === 1) {
      const cls = String(
        (node.className && (node.className.baseVal || node.className)) || "",
      );
      if (/nz/i.test(cls)) {
        const m = cls.match(/\bsec-([^-]+)\b/i);
        if (m && gaSectionIds.has(m[1])) return true;
      }
      node = node.parentNode;
    }
    return false;
  }

  function applyIdentifierStyle() {
    identifierElements.forEach((el) => {
      el.classList.remove("identifiers-normal", "identifiers-faint");
      const tag = (el.tagName && el.tagName.toLowerCase()) || "";
      const isGroup = tag === "g";
      const secId = el.dataset.sectionId;
      // GA = in gaSectionIds. Prefer ancestor's id when ancestor is GA so child paths stay visible
      const ancestorWithSec = el.closest && el.closest("[data-section-id]");
      const ancestorSecId =
        ancestorWithSec && ancestorWithSec !== el
          ? ancestorWithSec.dataset.sectionId
          : null;
      const effectiveSecId =
        ancestorSecId && gaSectionIds.has(ancestorSecId)
          ? ancestorSecId
          : secId || ancestorSecId;
      const isGA =
        (effectiveSecId && gaSectionIds.has(effectiveSecId)) ||
        isInsideNzSection(el);
      if (zoomLevel > ZOOM_THRESHOLD && !isGA) {
        // Zoomed in: hide non-GA identifiers to expose seats; GA sections stay visible (no seats to expose)
        el.classList.add("identifiers-faint");
        if (isGroup) {
          el.style.visibility = "visible";
          el.style.display = "";
          el.style.opacity = "";
          const hideNonText = (node) => {
            if (!node || node.nodeType !== 1) return;
            const t = (node.tagName && node.tagName.toLowerCase()) || "";
            if (t === "text" || t === "tspan") {
              node.style.visibility = "visible";
              node.style.display = "";
              Array.from(node.children || []).forEach(hideNonText);
              return;
            }
            node.style.visibility = "hidden";
            node.style.display = "none";
            Array.from(node.children || []).forEach(hideNonText);
          };
          Array.from(el.children || []).forEach(hideNonText);
        } else {
          el.style.visibility = "hidden";
          el.style.display = "none";
          el.style.opacity = "";
        }
      } else {
        // Zoomed out, or GA section at any zoom: keep identifier visible
        el.classList.add("identifiers-normal");
        el.style.visibility = "";
        el.style.display = "";
        el.style.opacity = "";
        if (isGroup) {
          el.querySelectorAll("*").forEach((child) => {
            child.style.visibility = "";
            child.style.display = "";
          });
        }
      }
    });
  }

  function onSeatEnter(e) {
    const rect = e.target;
    const sec = rect.dataset.sec,
      row = rect.dataset.row,
      seat = rect.dataset.seat;
    if (sec == null || sec === "") return;

    if (mode === "seat") {
      clearHighlights();
      rect.classList.add("seat-highlight");
      const accessible = rect.dataset.accessible === "true";
      const accessibleType = rect.dataset.accessibleType || null;
      showPopover(rect, {
        sec,
        row,
        seat,
        type: "seat",
        accessible,
        accessibleType,
      });
    } else if (mode === "row") {
      highlightRow(sec, row);
      const count = seatData.bySecRow[sec]?.[row] || 0;
      const accessible = rect.dataset.accessible === "true";
      const accessibleType = rect.dataset.accessibleType || null;
      showPopover(rect, {
        sec,
        row,
        rowSeats: count,
        type: "row",
        accessible,
        accessibleType,
      });
    } else if (mode === "section") {
      highlightSection(sec);
      const totalSeats = seatData.sections[sec] || 0;
      const totalRows = Object.keys(seatData.bySecRow[sec] || {}).length;
      const secU = String(sec).toUpperCase();
      const accessible = secU === "DA" || secU === "DB";
      const accessibleType = secU === "DA" ? "DA" : secU === "DB" ? "DB" : null;
      showPopover(rect, {
        sec,
        sectionSeats: totalSeats,
        sectionRows: totalRows,
        type: "section",
        accessible,
        accessibleType,
      });
    }
  }

  function onSeatLeave(e) {
    if (
      e.relatedTarget &&
      (e.relatedTarget.closest(".seat-highlight") ||
        e.relatedTarget.closest("[data-sec]") ||
        e.relatedTarget.closest("[data-section-id]"))
    )
      return;
    hidePopover();
    clearHighlights();
  }

  // If el is inside a group with class "sec-X NZ" where X is in gaSectionIds, return X; else null
  function getNzSectionIdFromAncestor(el) {
    let node = el && el.parentNode;
    while (node && node.nodeType === 1) {
      const cls = String(
        (node.className && (node.className.baseVal || node.className)) || "",
      );
      if (/nz/i.test(cls)) {
        const m = cls.match(/\bsec-([^-]+)\b/i);
        if (m && gaSectionIds.has(m[1])) return m[1];
      }
      node = node.parentNode;
    }
    return null;
  }

  function onSectionPathEnter(e, sectionId) {
    if (mode !== "section") return;
    let sec = normalizeSectionId(sectionId);
    if (!(sec in seatData.sections)) {
      const nzSec = getNzSectionIdFromAncestor(e.target);
      if (nzSec && nzSec in seatData.sections) sec = nzSec;
      else return;
    }
    highlightSection(sec);
    const totalSeats = seatData.sections[sec];
    const totalRows = Object.keys(seatData.bySecRow[sec] || {}).length;
    const isGA = totalRows === 0; // GA sections have no rows/seats
    const secU = String(sec).toUpperCase();
    const accessible = secU === "DA" || secU === "DB";
    const accessibleType = secU === "DA" ? "DA" : secU === "DB" ? "DB" : null;
    showPopoverAt(e.clientX, e.clientY, {
      sec,
      sectionSeats: totalSeats,
      sectionRows: totalRows,
      type: "section",
      isGA,
      accessible,
      accessibleType,
    });
  }

  function onSectionPathLeave(e) {
    if (
      e.relatedTarget &&
      (e.relatedTarget.closest("[data-section-id]") ||
        e.relatedTarget.closest("rect[data-sec]"))
    )
      return;
    hidePopover();
    clearHighlights();
  }

  function normalizeSectionId(id) {
    const key = String(id).toLowerCase();
    for (const k of Object.keys(seatData.sections)) {
      if (String(k).toLowerCase() === key) return k;
    }
    return id;
  }

  // Format section id for display: FULTONCENTERSUITE4 → "Fulton Center Suite 4"; never show NZ
  // Split by known words so we get sensible breaks (FULTON, CENTER, SUITE, etc.)
  const SECTION_DISPLAY_WORDS = [
    "CENTER",
    "SUITE",
    "FULTON",
    "PRESS",
    "BOX",
    "CLUB",
    "PATIO",
    "PARTY",
  ].sort((a, b) => b.length - a.length); // longest first so we match CENTER before shorter substrings
  function formatSectionDisplayName(secId) {
    if (secId == null || secId === "") return "";
    let s = String(secId)
      .trim()
      .replace(/\s*NZ\s*$/i, "")
      .trim();
    if (!s) return "";
    const upper = s.toUpperCase();
    const words = [];
    let i = 0;
    while (i < s.length) {
      const rest = upper.slice(i);
      let found = false;
      for (const w of SECTION_DISPLAY_WORDS) {
        if (rest.startsWith(w)) {
          words.push(s.slice(i, i + w.length));
          i += w.length;
          found = true;
          break;
        }
      }
      if (found) continue;
      const digitRun = /^\d+/.exec(rest);
      if (digitRun) {
        words.push(digitRun[0]);
        i += digitRun[0].length;
        continue;
      }
      const letterRun = /^[A-Za-z]+/.exec(rest);
      if (letterRun) {
        words.push(s.slice(i, i + letterRun[0].length));
        i += letterRun[0].length;
        continue;
      }
      i++;
    }
    return words.map((w) => (/^\d+$/.test(w) ? w : w.toUpperCase())).join(" ");
  }

  function highlightRow(sec, row) {
    clearHighlights();
    svgDoc
      .querySelectorAll(`rect[data-sec="${sec}"][data-row="${row}"]`)
      .forEach((r) => r.classList.add("seat-highlight"));
  }

  function highlightSection(sec) {
    clearHighlights();
    svgDoc
      .querySelectorAll(`rect[data-sec="${sec}"]`)
      .forEach((r) => r.classList.add("seat-highlight"));
  }

  function clearHighlights() {
    svgDoc
      ?.querySelectorAll(".seat-highlight")
      .forEach((r) => r.classList.remove("seat-highlight"));
  }

  function getAccessibleLabel(accessibleType) {
    if (accessibleType === "DA") return "Accessible • Open space";
    if (accessibleType === "DB") return "Accessible • Chairback";
    return "Accessible • Open space"; // fallback only if missing
  }

  function showPopover(anchor, data) {
    if (!data || data.sec == null || data.sec === "") return;
    popover.classList.remove("hidden");
    popSec.textContent = formatSectionDisplayName(data.sec);
    const accessible = !!data.accessible;
    popover.classList.toggle("has-accessible", accessible);
    if (popoverAccessibleEl) {
      popoverAccessibleEl.classList.toggle("hidden", !accessible);
    }
    if (popoverAccessibleLabel && accessible) {
      popoverAccessibleLabel.textContent = getAccessibleLabel(
        data.accessibleType,
      );
    }
    if (data.type === "seat") {
      popRowWrap.style.display = "";
      popRowLabel.textContent = "ROW";
      popRow.textContent = String(data.row ?? "—");
      popLastLabel.textContent = "SEAT";
      popSeat.textContent = String(data.seat ?? "—");
    } else if (data.type === "row") {
      popRowWrap.style.display = "";
      popRowLabel.textContent = "ROW";
      popRow.textContent = String(data.row ?? "—");
      popLastLabel.textContent = "TOTAL SEATS";
      popSeat.textContent = String(data.rowSeats ?? 0);
    } else {
      popRowWrap.style.display = "";
      popRowLabel.textContent = "TOTAL ROWS";
      popRow.textContent = String(data.sectionRows ?? 0);
      popLastLabel.textContent = "TOTAL SEATS";
      popSeat.textContent = String(data.sectionSeats ?? 0);
    }
    positionPopover(anchor);
  }

  function showPopoverAt(clientX, clientY, data) {
    if (!data || data.sec == null || data.sec === "") return;
    popover.classList.remove("hidden");
    popSec.textContent = formatSectionDisplayName(data.sec);
    const accessible = !!data.accessible;
    popover.classList.toggle("has-accessible", accessible);
    if (popoverAccessibleEl) {
      popoverAccessibleEl.classList.toggle("hidden", !accessible);
    }
    if (popoverAccessibleLabel && accessible) {
      popoverAccessibleLabel.textContent = getAccessibleLabel(
        data.accessibleType,
      );
    }
    // GA sections: show section name and capacity only (manually entered when map was added)
    if (data.isGA) {
      popRowWrap.style.display = "none";
      popLastLabel.textContent = "Capacity";
      popSeat.textContent = String(data.sectionSeats ?? 0);
    } else {
      popRowWrap.style.display = "";
      popRowLabel.textContent = "TOTAL ROWS";
      popRow.textContent = String(data.sectionRows ?? 0);
      popLastLabel.textContent = "TOTAL SEATS";
      popSeat.textContent = String(data.sectionSeats ?? 0);
    }
    popover.style.left = clientX + "px";
    popover.style.top = clientY - 12 + "px";
    popover.style.transform = "translate(-50%, -100%)";
  }

  function positionPopover(anchor) {
    const rect = anchor.getBoundingClientRect();
    popover.style.left = rect.left + rect.width / 2 + "px";
    popover.style.top = rect.top - 8 + "px";
    popover.style.transform = "translate(-50%, -100%)";
  }

  function hidePopover() {
    popover.classList.add("hidden");
  }

  function showRouteLoadError(message) {
    console.error(message);
    const uploadText = uploadScreen?.querySelector(".upload-area p");
    if (uploadText) {
      uploadText.textContent = message;
    }
  }

  function loadProjectFromUrlCandidates(projectUrls) {
    const candidates = Array.isArray(projectUrls) ? projectUrls : [projectUrls];
    const tryFetch = (index) => {
      if (index >= candidates.length)
        return Promise.reject(new Error("Project file not found"));
      return fetch(candidates[index])
        .then((r) => {
          if (!r.ok) throw new Error("HTTP " + r.status);
          return r.json();
        })
        .catch(() => tryFetch(index + 1));
    };

    tryFetch(0)
      .then((r) => {
        return r;
      })
      .then((project) => {
        if (
          project &&
          typeof project.svg === "string" &&
          project.capacities &&
          typeof project.capacities === "object"
        ) {
          loadSvg(project.svg, project.capacities);
          uploadScreen.classList.add("hidden");
          mapScreen.classList.remove("hidden");
        }
      })
      .catch(() => {
        // Keep upload screen visible and report route-load issue.
        showRouteLoadError(
          "Could not auto-load project file for this route. Tried: " +
            candidates.join(", "),
        );
      });
  }

  // If URL has ?project=path/to/file.svgqc, fetch and load it so the client sees the final product without uploading
  const projectParam = new URLSearchParams(window.location.search).get(
    "project",
  );
  if (projectParam) {
    const projectUrls = [
      new URL(projectParam, window.location.href).href,
      new URL(projectParam, window.location.origin + "/").href,
    ];
    loadProjectFromUrlCandidates(projectUrls);
  } else {
    // Route-based project loading for shareable short URLs
    const routeProjects = [
      {
        slug: "/aggie-memorial-stadium",
        projectFile: "aggie.svgqc",
      },
      {
        slug: "/pan-american-center",
        projectFile: "pan-american-center.svgqc",
      },
    ];
    const routePath =
      (window.location.pathname || "/").replace(/\/+$/, "").toLowerCase() ||
      "/";
    const matchedRoute = routeProjects.find((r) => routePath.endsWith(r.slug));
    const projectFile = matchedRoute?.projectFile;
    if (projectFile) {
      const encodedProjectFile = encodeURIComponent(projectFile).replace(
        /%2F/g,
        "/",
      );
      const projectUrls = [
        // Strongest candidates first
        window.location.origin + "/" + encodedProjectFile,
        window.location.origin + "/./" + encodedProjectFile,
        // Fallbacks for prefixed/static hosting layouts
        new URL(projectFile, window.location.href).href,
        new URL(projectFile, window.location.origin + routePath + "/../").href,
      ];
      loadProjectFromUrlCandidates(projectUrls);
    }
  }
})();
