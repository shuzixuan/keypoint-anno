// ── Global State ────────────────────────────────────────────────
const state = {
  images: [],
  currentImageIdx: -1,
  currentImage: null,       // image metadata
  imgElement: null,         // loaded HTMLImageElement
  config: null,             // keypoint config from /api/config
  annotations: [],          // annotations for current image
  activeInstanceIdx: 0,

  // View transform: screen = image * zoom + pan
  zoom: 1.0,
  panX: 0,
  panY: 0,

  // Interaction
  dragging: null,           // {kpIdx, annIdx, startX, startY, origImgX, origImgY}
  panning: false,
  panStartX: 0,
  panStartY: 0,
  hoveredKp: null,          // {kpIdx, annIdx}
  hoverSource: 'mouse',     // 'mouse' or 'sidebar'

  // Confidence filter (0–1)
  confThreshold: 0.0,

  // Undo
  undoStack: [],
  maxUndo: 50,

  // Save state
  modified: false,
  nextAnnId: 0,

  // UI flags
  showSkeleton: true,
  showLabels: true,

  // Mode: 'annotate' or 'review'
  mode: 'annotate',
};

// ── DOM References ──────────────────────────────────────────────
const canvas = document.getElementById('main-canvas');
const ctx = canvas.getContext('2d');
const imageList = document.getElementById('image-list');
const instanceSelector = document.getElementById('instance-selector');
const confSlider = document.getElementById('confidence-slider');
const confValue = document.getElementById('confidence-value');
const saveStatus = document.getElementById('save-status');
const zoomDisplay = document.getElementById('zoom-display');
const imageInfo = document.getElementById('image-info');
const navInfo = document.getElementById('nav-info');
const canvasPlaceholder = document.getElementById('canvas-placeholder');
const canvasContainer = document.getElementById('canvas-container');
const searchBox = document.getElementById('search-box');
const toggleReviewed = document.getElementById('toggle-reviewed');
const btnNextUnreviewed = document.getElementById('btn-next-unreviewed');
const btnMode = document.getElementById('btn-mode');
const btnSave = document.getElementById('btn-save');

// ── Initialization ──────────────────────────────────────────────
async function init() {
  try {
    state.config = await (await fetch('/api/config')).json();
    state.images = await (await fetch('/api/images')).json();
  } catch (e) {
    console.error('Failed to load config/images:', e);
    canvasPlaceholder.textContent = 'Failed to connect to server.';
    return;
  }

  renderImageList();
  if (state.images.length > 0) {
    selectImage(0);
  } else {
    canvasPlaceholder.textContent = 'No images found.';
  }

  setupEventListeners();
  window.addEventListener('resize', () => {
    resizeCanvas();
    render();
  });

  // Auto-save every 60s if modified
  setInterval(() => {
    if (state.modified) {
      saveAnnotations().then(() => {
        console.log('Auto-saved');
      });
    }
  }, 60000);

  // Auto-save before closing tab (sendBeacon guarantees delivery)
  window.addEventListener('beforeunload', () => {
    if (state.modified) {
      navigator.sendBeacon('/api/save', '{}');
    }
  });
}

// ── Image List ──────────────────────────────────────────────────
function renderImageList(filter = '') {
  imageList.innerHTML = '';
  const f = filter.toLowerCase();
  for (const img of state.images) {
    if (f && !img.file_name.toLowerCase().includes(f)) continue;
    const div = document.createElement('div');
    div.className = 'image-item';
    if (img.index === state.currentImageIdx) div.classList.add('active');
    if (img.reviewed) div.classList.add('reviewed');
    const reviewIcon = img.reviewed ? '✓ ' : '';
    div.innerHTML = `<span>${reviewIcon}${img.file_name}</span><span class="ann-count">${img.annotation_count}</span>`;
    div.addEventListener('click', () => selectImage(img.index));
    imageList.appendChild(div);
  }
  const reviewedCount = state.images.filter(i => i.reviewed).length;
  document.getElementById('image-count').textContent =
    `${state.images.length} images (${reviewedCount} reviewed)`;
}

async function selectImage(idx) {
  if (idx < 0 || idx >= state.images.length) return;

  // Auto-save before navigating away
  if (state.modified && state.currentImageIdx !== idx) {
    await saveAnnotations();
  }

  state.currentImageIdx = idx;
  state.currentImage = state.images[idx];
  state.activeInstanceIdx = 0;
  state.undoStack = [];
  state.hoveredKp = null;
  state.dragging = null;

  // Update review toggle to match current image
  if (toggleReviewed) {
    toggleReviewed.checked = state.currentImage.reviewed || false;
  }

  loadImageAndAnnotations();
  renderImageList(searchBox.value);
  updateNavInfo();
}

async function loadImageAndAnnotations() {
  const imgMeta = state.currentImage;
  if (!imgMeta) return;

  canvasPlaceholder.style.display = 'block';

  // Load image
  const img = new Image();
  img.onload = async () => {
    state.imgElement = img;
    canvasPlaceholder.style.display = 'none';

    // Load annotations
    const resp = await fetch(`/api/annotations?image_id=${imgMeta.id}`);
    state.annotations = await resp.json();

    // Fallback: if no annotations but image has width/height, create empty list
    if (!state.annotations.length && imgMeta.annotation_count === 0) {
      // no-op; user can add instances
    }

    if (state.annotations.length > 0) {
      state.activeInstanceIdx = 0;
    }

    updateInstanceUI();
    resizeCanvas();
    fitToView();
    render();
  };
  img.onerror = () => {
    canvasPlaceholder.textContent = 'Failed to load image.';
  };
  img.src = `/api/images/${imgMeta.id}`;
}

// ── Canvas ───────────────────────────────────────────────────────
function resizeCanvas() {
  const rect = canvasContainer.getBoundingClientRect();
  canvas.width = rect.width;
  canvas.height = rect.height;
}

function fitToView() {
  if (!state.imgElement) return;
  const iw = state.imgElement.naturalWidth;
  const ih = state.imgElement.naturalHeight;
  if (!iw || !ih) return;

  const cw = canvas.width;
  const ch = canvas.height;
  const scale = Math.min(cw / iw, ch / ih) * 0.92;
  state.zoom = scale;
  state.panX = (cw - iw * scale) / 2;
  state.panY = (ch - ih * scale) / 2;
  updateZoomDisplay();
}

function screenToImage(sx, sy) {
  return {
    x: (sx - state.panX) / state.zoom,
    y: (sy - state.panY) / state.zoom,
  };
}

function imageToScreen(ix, iy) {
  return {
    x: ix * state.zoom + state.panX,
    y: iy * state.zoom + state.panY,
  };
}

// ── Render ───────────────────────────────────────────────────────
function render() {
  if (!canvas || !ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Background
  ctx.fillStyle = '#11111b';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (!state.imgElement) return;

  ctx.save();
  ctx.setTransform(state.zoom, 0, 0, state.zoom, state.panX, state.panY);

  // Draw image
  ctx.drawImage(state.imgElement, 0, 0);

  // Draw skeleton for each instance
  if (state.showSkeleton && state.config) {
    for (let aIdx = 0; aIdx < state.annotations.length; aIdx++) {
      drawSkeleton(state.annotations[aIdx], aIdx);
    }
  }

  // Draw keypoints for each instance
  if (state.config) {
    for (let aIdx = 0; aIdx < state.annotations.length; aIdx++) {
      drawKeypoints(state.annotations[aIdx], aIdx);
    }
  }

  ctx.restore();

  // Update image info text and keypoint sidebar
  const img = state.currentImage;
  renderKeypointSidebar();
  if (img) {
    imageInfo.textContent = `${img.file_name}  ${img.width || '?'}x${img.height || '?'}  ${state.annotations.length} instances`;
  }
  // Update interpolated keypoint count for active instance
  const activeAnn = getActiveAnnotation();
  const interpEl = document.getElementById('interp-count-value');
  if (interpEl) {
    if (activeAnn && activeAnn.keypoint_status) {
      const count = activeAnn.keypoint_status.filter(s => s === 'interpolated').length;
      interpEl.textContent = count;
      interpEl.style.display = count > 0 ? '' : 'none';
    } else {
      interpEl.textContent = '0';
      interpEl.style.display = 'none';
    }
  }
}

function drawSkeleton(ann, annIdx) {
  const sk = state.config.skeleton;
  if (!sk) return;

  const kps = ann.keypoints;
  const isActive = annIdx === state.activeInstanceIdx;

  for (const skId of Object.keys(sk)) {
    const link = sk[skId];
    const names = link.link; // ["EarL", "EarR"]
    if (!names || names.length !== 2) continue;

    const idxA = getKpIndex(names[0]);
    const idxB = getKpIndex(names[1]);
    if (idxA < 0 || idxB < 0) continue;

    const ax = kps[idxA * 3];
    const ay = kps[idxA * 3 + 1];
    const av = kps[idxA * 3 + 2];
    const bx = kps[idxB * 3];
    const by = kps[idxB * 3 + 1];
    const bv = kps[idxB * 3 + 2];

    if (av === 0 || bv === 0) continue;

    const confA = getKeypointConfidence(ann, idxA);
    const confB = getKeypointConfidence(ann, idxB);
    const minConf = Math.min(confA, confB);

    if (minConf < state.confThreshold) continue;

    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);

    const color = link.color || [180, 180, 180];
    const alpha = isActive ? 1.0 : 0.35;
    ctx.strokeStyle = `rgba(${color[0]},${color[1]},${color[2]},${alpha})`;
    ctx.lineWidth = isActive ? 2.2 / state.zoom : 1.2 / state.zoom;
    ctx.stroke();
  }
}

function drawKeypoints(ann, annIdx) {
  const kpConfig = state.config.keypoints;
  if (!kpConfig) return;

  const kps = ann.keypoints;
  const isActive = annIdx === state.activeInstanceIdx;
  const numKp = Object.keys(kpConfig).length;

  for (let k = 0; k < numKp; k++) {
    const x = kps[k * 3];
    const y = kps[k * 3 + 1];
    const v = kps[k * 3 + 2];
    if (v === 0 && !isActive) continue; // Hide unlabeled kps for inactive instances

    const conf = getKeypointConfidence(ann, k);
    const kpStatus = getKeypointStatus(ann, k);
    const needsReview = kpStatus === 'interpolated';
    const affectedByThreshold = (state.mode === 'review' || !isActive) && !needsReview;
    const belowThreshold = affectedByThreshold && conf < state.confThreshold;

    const kpInfo = kpConfig[String(k)] || {};
    const color = belowThreshold ? [128, 128, 128] : (kpInfo.color || [200, 200, 200]);

    const fullAlpha = isActive && state.mode !== 'review';
    let alpha = fullAlpha ? 1.0 : 0.4;
    if (belowThreshold) {
      alpha *= 0.3;
    } else if (conf < 0.5 && !fullAlpha) {
      alpha *= 0.5 + conf;
    }

    // Occluded (v=1) shown with dashed appearance
    if (v === 1) {
      alpha *= 0.6;
    }

    const radius = isActive ? 5.5 / state.zoom : 4 / state.zoom;

    // Highlight hovered keypoint
    const isHovered = state.hoveredKp &&
      state.hoveredKp.annIdx === annIdx &&
      state.hoveredKp.kpIdx === k;

    // Draw filled circle
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${color[0]},${color[1]},${color[2]},${alpha})`;
    ctx.fill();

    // Border
    if (v === 1) {
      ctx.setLineDash([3 / state.zoom, 3 / state.zoom]);
    }
    ctx.strokeStyle = isHovered
      ? 'rgba(255,255,255,0.95)'
      : `rgba(255,255,255,${alpha * 0.7})`;
    ctx.lineWidth = isHovered ? 2.5 / state.zoom : 1.2 / state.zoom;
    ctx.stroke();
    ctx.setLineDash([]);

    // Status-specific visual indicators
    if (isActive) {
      if (kpStatus === 'interpolated') {
        ctx.beginPath();
        ctx.arc(x, y, radius * 1.55, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255, 165, 0, ${alpha * 0.75})`;
        ctx.lineWidth = 1.5 / state.zoom;
        ctx.setLineDash([2.5 / state.zoom, 2.5 / state.zoom]);
        ctx.stroke();
        ctx.setLineDash([]);
      } else if (kpStatus === 'corrected') {
        ctx.beginPath();
        ctx.arc(x, y, radius * 1.55, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(46, 204, 113, ${alpha * 0.9})`;
        ctx.lineWidth = 2.0 / state.zoom;
        ctx.stroke();
        // Small checkmark
        const cr = radius * 1.05;
        ctx.strokeStyle = `rgba(46, 204, 113, 0.9)`;
        ctx.lineWidth = 1.5 / state.zoom;
        ctx.beginPath();
        ctx.moveTo(x - cr * 0.5, y);
        ctx.lineTo(x - cr * 0.12, y + cr * 0.42);
        ctx.lineTo(x + cr * 0.55, y - cr * 0.5);
        ctx.stroke();
      }
    }

    // Label
    if (state.showLabels && isActive && kpInfo.name) {
      const fontSize = Math.max(10, 12 / state.zoom);
      ctx.font = `${fontSize}px "Segoe UI", system-ui, sans-serif`;
      ctx.fillStyle = `rgba(255,255,255,${alpha})`;
      ctx.fillText(kpInfo.name, x + radius + 3 / state.zoom, y + fontSize / 3);
    }

    // Unlabeled (v=0) for active instance: draw as small cross
    if (v === 0 && isActive) {
      const cr = 3 / state.zoom;
      ctx.strokeStyle = isHovered ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.3)';
      ctx.lineWidth = isHovered ? 1.5 / state.zoom : 0.8 / state.zoom;
      ctx.beginPath();
      ctx.moveTo(x - cr, y - cr);
      ctx.lineTo(x + cr, y + cr);
      ctx.moveTo(x + cr, y - cr);
      ctx.lineTo(x - cr, y + cr);
      ctx.stroke();
      // Show name even when unlabeled if hovered via sidebar
      if (isHovered && state.showLabels && kpInfo.name) {
        const fontSize = Math.max(10, 12 / state.zoom);
        ctx.font = `${fontSize}px "Segoe UI", system-ui, sans-serif`;
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        ctx.fillText(kpInfo.name, x + radius + 3 / state.zoom, y + fontSize / 3);
      }
    }
  }

  // Instance label
  if (isActive && state.annotations.length > 1) {
    // Find topmost keypoint for label placement
    let minY = Infinity, labelX = 0;
    for (let k = 0; k < numKp; k++) {
      const v = kps[k * 3 + 2];
      if (v === 0) continue;
      const y = kps[k * 3 + 1];
      if (y < minY) { minY = y; labelX = kps[k * 3]; }
    }
    if (minY < Infinity) {
      const fontSize = Math.max(11, 14 / state.zoom);
      ctx.font = `bold ${fontSize}px "Segoe UI", system-ui, sans-serif`;
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillText(`#${annIdx + 1}`, labelX, minY - 10 / state.zoom);
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────
function getKpIndex(name) {
  for (const [idStr, info] of Object.entries(state.config.keypoints || {})) {
    if (info.name === name) return parseInt(idStr);
  }
  return -1;
}

function getKeypointConfidence(ann, kpIdx) {
  // Priority: per-keypoint scores, then annotation score, then default
  if (ann.keypoint_scores && ann.keypoint_scores[kpIdx] !== undefined) {
    return ann.keypoint_scores[kpIdx];
  }
  return ann.score !== undefined ? ann.score : 1.0;
}

function getKeypointStatus(ann, kpIdx) {
  if (ann.keypoint_status && ann.keypoint_status[kpIdx] !== undefined) {
    return ann.keypoint_status[kpIdx];
  }
  return 'predicted';
}

function renderKeypointSidebar() {
  const kpConfig = state.config ? state.config.keypoints : null;
  const kpList = document.getElementById('kp-list');
  if (!kpList || !kpConfig) return;

  const activeAnn = getActiveAnnotation();
  const numKp = Object.keys(kpConfig).length;
  kpList.innerHTML = '';

  for (let k = 0; k < numKp; k++) {
    const info = kpConfig[String(k)] || {};
    const name = info.name || `KP${k}`;
    const color = info.color || [200, 200, 200];
    const v = activeAnn ? activeAnn.keypoints[k * 3 + 2] : 0;
    const status = activeAnn ? getKeypointStatus(activeAnn, k) : 'predicted';
    const conf = activeAnn ? getKeypointConfidence(activeAnn, k) : 1.0;

    const isHovered = state.hoveredKp &&
      state.hoveredKp.annIdx === state.activeInstanceIdx &&
      state.hoveredKp.kpIdx === k;

    const row = document.createElement('div');
    row.className = 'kp-row' + (isHovered ? ' active' : '');
    row.dataset.kpIdx = k;

    // Color swatch
    const swatch = document.createElement('span');
    swatch.className = 'kp-swatch';
    swatch.style.backgroundColor = `rgb(${color[0]},${color[1]},${color[2]})`;

    // Name
    const nameSpan = document.createElement('span');
    nameSpan.className = 'kp-name';
    nameSpan.textContent = name;

    // Status badge
    const badge = document.createElement('span');
    badge.className = 'kp-page-badge ' + status;
    badge.textContent = status === 'predicted' ? 'P' : status === 'interpolated' ? 'E' : 'C';
    const statusLabel = status === 'predicted' ? 'Predicted (ViTPose)' : status === 'interpolated' ? 'Estimated (needs review)' : 'Corrected (manual)';
    badge.title = statusLabel;

    // Labeled indicator dot
    const dot = document.createElement('span');
    dot.className = 'kp-status-dot ' + (v > 0 ? 'labeled' : 'unlabeled');
    dot.title = v > 0 ? (v === 2 ? 'Labeled (visible)' : 'Labeled (occluded)') : 'Unlabeled (click to select, then dblclick canvas to place)';

    // Confidence
    const isPerKp = activeAnn && activeAnn.keypoint_scores && activeAnn.keypoint_scores[k] !== undefined;
    const confSpan = document.createElement('span');
    confSpan.className = 'kp-conf' + (isPerKp ? '' : ' kp-conf-fallback');
    confSpan.textContent = isPerKp ? conf.toFixed(2) : '~' + conf.toFixed(2);
    confSpan.title = isPerKp ? 'Per-keypoint ViTPose score' : 'Annotation-level score (no per-kp data)';

    row.appendChild(swatch);
    row.appendChild(nameSpan);
    row.appendChild(badge);
    row.appendChild(dot);
    row.appendChild(confSpan);

    row.addEventListener('click', () => {
      if (state.mode === 'review') return;
      state.hoveredKp = { annIdx: state.activeInstanceIdx, kpIdx: k };
      state.hoverSource = 'sidebar';
      render(); // re-render both canvas and sidebar
    });

    kpList.appendChild(row);
  }
}

function getActiveAnnotation() {
  if (state.annotations.length === 0) return null;
  if (state.activeInstanceIdx >= state.annotations.length) {
    state.activeInstanceIdx = state.annotations.length - 1;
  }
  if (state.activeInstanceIdx < 0) return null;
  return state.annotations[state.activeInstanceIdx];
}

function markModified() {
  state.modified = true;
  saveStatus.textContent = 'Modified';
  saveStatus.className = 'save-status modified';
}

function markSaved() {
  state.modified = false;
  saveStatus.textContent = 'Saved';
  saveStatus.className = 'save-status saved';
}

// ── Instance Management ──────────────────────────────────────────
function updateInstanceUI() {
  instanceSelector.innerHTML = '';
  for (let i = 0; i < state.annotations.length; i++) {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = `Instance ${i + 1}`;
    if (i === state.activeInstanceIdx) opt.selected = true;
    instanceSelector.appendChild(opt);
  }
}

async function addInstance() {
  if (state.mode === 'review') return;
  if (!state.currentImage) return;
  const resp = await fetch('/api/annotations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      image_id: state.currentImage.id,
      category_id: 1,
      score: 1.0,
    }),
  });
  const data = await resp.json();
  const newAnn = data.annotation;
  state.annotations.push(newAnn);
  state.activeInstanceIdx = state.annotations.length - 1;
  updateInstanceUI();

  // Update image annotation count in list
  state.currentImage.annotation_count = state.annotations.length;
  renderImageList(searchBox.value);

  markModified();
  render();
}

async function deleteInstance() {
  if (state.mode === 'review') return;
  if (state.annotations.length <= 1) return;
  const ann = state.annotations[state.activeInstanceIdx];
  if (!ann) return;
  await fetch(`/api/annotations/${ann.id}`, { method: 'DELETE' });
  state.annotations.splice(state.activeInstanceIdx, 1);
  if (state.activeInstanceIdx >= state.annotations.length) {
    state.activeInstanceIdx = state.annotations.length - 1;
  }
  updateInstanceUI();
  state.currentImage.annotation_count = state.annotations.length;
  renderImageList(searchBox.value);
  markModified();
  render();
}

// ── Save / Export ────────────────────────────────────────────────
async function saveAnnotations() {
  if (state.mode === 'review') return;
  try {
    const resp = await fetch('/api/save', { method: 'POST' });
    const data = await resp.json();
    markSaved();
    console.log(`Saved ${data.count} annotations to ${data.path}`);
  } catch (e) {
    saveStatus.textContent = 'Save failed';
    saveStatus.className = 'save-status error';
    console.error('Save failed:', e);
  }
}

function exportAnnotations() {
  fetch('/api/export')
    .then(r => r.json())
    .then(data => {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'annotations_export.json';
      a.click();
      URL.revokeObjectURL(url);
    });
}

// ── Mode Toggle ──────────────────────────────────────────────────
function toggleMode() {
  state.mode = state.mode === 'annotate' ? 'review' : 'annotate';
  updateModeUI();
  render();
}

function updateModeUI() {
  const inReview = state.mode === 'review';
  btnMode.textContent = inReview ? 'Review' : 'Annotate';
  btnMode.style.background = inReview ? '#553311' : '#313244';
  // Disable editing controls in review mode
  btnSave.disabled = inReview;
  btnAddInstance.disabled = inReview;
  btnDelInstance.disabled = inReview;
  instanceSelector.disabled = inReview;
}

// ── Review Tracking ──────────────────────────────────────────────
async function toggleImageReview() {
  if (!state.currentImage) return;
  const img = state.currentImage;
  const newStatus = !img.reviewed;

  try {
    await fetch(`/api/images/${img.id}/review`, { method: 'POST' });
    img.reviewed = newStatus;
    // Also update in the images array
    const imgRef = state.images[img.index];
    if (imgRef) imgRef.reviewed = newStatus;
    if (toggleReviewed) toggleReviewed.checked = newStatus;
    renderImageList(searchBox.value);
  } catch (e) {
    console.error('Failed to toggle review:', e);
  }
}

function jumpToNextUnreviewed() {
  // Search forward from current position
  for (let i = state.currentImageIdx + 1; i < state.images.length; i++) {
    if (!state.images[i].reviewed) {
      selectImage(i);
      return;
    }
  }
  // Wrap around: search from beginning
  for (let i = 0; i < state.currentImageIdx; i++) {
    if (!state.images[i].reviewed) {
      selectImage(i);
      return;
    }
  }
  // All reviewed
  console.log('All images reviewed!');
}

// ── Undo ─────────────────────────────────────────────────────────
function pushUndo(annId, kpIdx, oldX, oldY, oldV, oldStatus) {
  state.undoStack.push({ annId, kpIdx, oldX, oldY, oldV, oldStatus });
  if (state.undoStack.length > state.maxUndo) {
    state.undoStack.shift();
  }
}

function undo() {
  if (state.mode === 'review') return;
  if (state.undoStack.length === 0) return;
  const action = state.undoStack.pop();

  // Find the annotation
  for (const ann of state.annotations) {
    if (ann.id === action.annId) {
      ann.keypoints[action.kpIdx * 3] = action.oldX;
      ann.keypoints[action.kpIdx * 3 + 1] = action.oldY;
      ann.keypoints[action.kpIdx * 3 + 2] = action.oldV;
      if (action.oldStatus !== undefined && ann.keypoint_status) {
        ann.keypoint_status[action.kpIdx] = action.oldStatus;
      }
      markModified();
      render();
      return;
    }
  }
}

// ── Event Setup ──────────────────────────────────────────────────
function setupEventListeners() {
  // Canvas mouse events
  canvas.addEventListener('mousedown', onMouseDown);
  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('mouseup', onMouseUp);
  canvas.addEventListener('mouseleave', onMouseUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('dblclick', onDblClick);

  // Toolbar buttons
  document.getElementById('btn-save').addEventListener('click', saveAnnotations);
  document.getElementById('btn-export').addEventListener('click', exportAnnotations);
  document.getElementById('btn-zoom-in').addEventListener('click', () => zoomBy(1.25));
  document.getElementById('btn-zoom-out').addEventListener('click', () => zoomBy(1 / 1.25));
  document.getElementById('btn-fit').addEventListener('click', () => { fitToView(); render(); });
  document.getElementById('btn-prev').addEventListener('click', () => {
    if (state.currentImageIdx > 0) selectImage(state.currentImageIdx - 1);
  });
  document.getElementById('btn-next').addEventListener('click', () => {
    if (state.currentImageIdx < state.images.length - 1)
      selectImage(state.currentImageIdx + 1);
  });

  // Instance controls
  instanceSelector.addEventListener('change', () => {
    state.activeInstanceIdx = parseInt(instanceSelector.value);
    render();
  });
  document.getElementById('btn-add-instance').addEventListener('click', addInstance);
  document.getElementById('btn-del-instance').addEventListener('click', deleteInstance);

  // Confidence slider
  confSlider.addEventListener('input', () => {
    state.confThreshold = parseInt(confSlider.value) / 100;
    confValue.textContent = state.confThreshold.toFixed(2);
    render();
  });

  // Toggle switches
  document.getElementById('toggle-skeleton').addEventListener('change', (e) => {
    state.showSkeleton = e.target.checked;
    render();
  });
  document.getElementById('toggle-labels').addEventListener('change', (e) => {
    state.showLabels = e.target.checked;
    render();
  });

  // Search
  searchBox.addEventListener('input', () => {
    renderImageList(searchBox.value);
  });

  // Review controls
  if (toggleReviewed) {
    toggleReviewed.addEventListener('change', toggleImageReview);
  }
  if (btnNextUnreviewed) {
    btnNextUnreviewed.addEventListener('click', jumpToNextUnreviewed);
  }
  if (btnMode) {
    btnMode.addEventListener('click', toggleMode);
  }

  // Help panel
  document.getElementById('help-toggle').addEventListener('click', () => {
    document.getElementById('help-panel').style.display = 'block';
  });
  document.getElementById('btn-help-close').addEventListener('click', () => {
    document.getElementById('help-panel').style.display = 'none';
  });

  // Keyboard
  window.addEventListener('keydown', onKeyDown);
}

// ── Mouse Handlers ───────────────────────────────────────────────
function onMouseDown(e) {
  if (!state.imgElement || !state.annotations.length) return;

  // In review mode, only allow panning (no keypoint dragging)
  if (state.mode === 'review') {
    state.panning = true;
    state.panStartX = e.clientX;
    state.panStartY = e.clientY;
    return;
  }

  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  const imgPt = screenToImage(sx, sy);

  // Hit test keypoints on the active instance
  const activeAnn = getActiveAnnotation();
  if (activeAnn) {
    const hitRadius = 8 / state.zoom; // 8 screen pixels
    const kps = activeAnn.keypoints;
    const numKp = Object.keys(state.config.keypoints || {}).length;

    for (let k = 0; k < numKp; k++) {
      const kx = kps[k * 3];
      const ky = kps[k * 3 + 1];
      const kv = kps[k * 3 + 2];
      if (kv === 0) continue;

      const dx = imgPt.x - kx;
      const dy = imgPt.y - ky;
      if (Math.sqrt(dx * dx + dy * dy) < hitRadius) {
        state.dragging = {
          annIdx: state.activeInstanceIdx,
          kpIdx: k,
          origImgX: kx,
          origImgY: ky,
          origV: kv,
          origStatus: activeAnn.keypoint_status ? activeAnn.keypoint_status[k] : 'predicted',
        };
        canvasContainer.classList.add('dragging-kp');
        return;
      }
    }
  }

  // No keypoint hit — begin panning
  state.panning = true;
  state.panStartX = e.clientX;
  state.panStartY = e.clientY;
}

function onMouseMove(e) {
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;

  if (state.dragging) {
    const imgPt = screenToImage(sx, sy);
    const ann = state.annotations[state.dragging.annIdx];
    if (ann) {
      ann.keypoints[state.dragging.kpIdx * 3] = imgPt.x;
      ann.keypoints[state.dragging.kpIdx * 3 + 1] = imgPt.y;
      ann.keypoints[state.dragging.kpIdx * 3 + 2] = 2; // visible
    }
    render();
    return;
  }

  if (state.panning) {
    state.panX += e.clientX - state.panStartX;
    state.panY += e.clientY - state.panStartY;
    state.panStartX = e.clientX;
    state.panStartY = e.clientY;
    render();
    return;
  }

  // Hover detection
  if (state.imgElement && state.annotations.length > 0) {
    const imgPt = screenToImage(sx, sy);
    const hitRadius = 8 / state.zoom;
    let found = null;

    const activeAnn = getActiveAnnotation();
    if (activeAnn) {
      const kps = activeAnn.keypoints;
      const numKp = Object.keys(state.config.keypoints || {}).length;
      for (let k = 0; k < numKp; k++) {
        if (kps[k * 3 + 2] === 0) continue;
        const dx = imgPt.x - kps[k * 3];
        const dy = imgPt.y - kps[k * 3 + 1];
        if (Math.sqrt(dx * dx + dy * dy) < hitRadius) {
          found = { annIdx: state.activeInstanceIdx, kpIdx: k };
          break;
        }
      }
    }

    // When sidebar has locked a selection, ignore all mouse hovers
    if (state.hoverSource === 'sidebar') {
      // Sidebar lock is active — do nothing on mouse move
      // User must complete operation (drag/place/delete) or click another sidebar row
    } else if (!found && state.hoveredKp) {
      // Normal mouse hover — clear when leaving the keypoint
      state.hoveredKp = null;
      render();
    } else if (found && (!state.hoveredKp ||
               state.hoveredKp.kpIdx !== found.kpIdx ||
               state.hoveredKp.annIdx !== found.annIdx)) {
      state.hoveredKp = found;
      render();
    }
  }
}

function onMouseUp(e) {
  if (state.dragging) {
    const ann = state.annotations[state.dragging.annIdx];
    if (ann) {
      // Check if actually moved
      const newX = ann.keypoints[state.dragging.kpIdx * 3];
      const newY = ann.keypoints[state.dragging.kpIdx * 3 + 1];
      if (newX !== state.dragging.origImgX || newY !== state.dragging.origImgY) {
        pushUndo(ann.id, state.dragging.kpIdx,
                 state.dragging.origImgX, state.dragging.origImgY, state.dragging.origV,
                 state.dragging.origStatus);
        // Upgrade status to corrected
        if (!ann.keypoint_status) ann.keypoint_status = [];
        ann.keypoint_status[state.dragging.kpIdx] = 'corrected';
        markModified();
        // Sync to server (silent)
        syncAnnotation(ann);
      }
    }
    state.dragging = null;
    state.hoverSource = 'mouse';  // Release sidebar lock after operation
    canvasContainer.classList.remove('dragging-kp');
    render();
  }

  state.panning = false;
}

function onWheel(e) {
  if (!state.imgElement) return;
  e.preventDefault();

  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;

  // Zoom toward cursor position
  const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
  const newZoom = Math.max(0.05, Math.min(20, state.zoom * factor));

  // Adjust pan so the point under cursor stays fixed
  state.panX = sx - (sx - state.panX) * (newZoom / state.zoom);
  state.panY = sy - (sy - state.panY) * (newZoom / state.zoom);
  state.zoom = newZoom;

  updateZoomDisplay();
  render();
}

function onDblClick(e) {
  if (state.mode === 'review') return;
  // Double-click on empty area: find nearest unlabeled keypoint and place it
  if (!state.imgElement) return;
  const activeAnn = getActiveAnnotation();
  if (!activeAnn) return;

  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  const imgPt = screenToImage(sx, sy);

  const kps = activeAnn.keypoints;
  const numKp = Object.keys(state.config.keypoints || {}).length;
  let targetKp = -1;

  // Prefer the sidebar-selected (hovered) keypoint if it's v=0
  if (state.hoveredKp &&
      state.hoveredKp.annIdx === state.activeInstanceIdx &&
      kps[state.hoveredKp.kpIdx * 3 + 2] === 0) {
    targetKp = state.hoveredKp.kpIdx;
  }
  // Otherwise find the first unlabeled (v=0) keypoint in config order
  if (targetKp < 0) {
    for (let k = 0; k < numKp; k++) {
      if (kps[k * 3 + 2] === 0) {
        targetKp = k;
        break;
      }
    }
  }

  if (targetKp >= 0) {
    const oldStatus = activeAnn.keypoint_status ? activeAnn.keypoint_status[targetKp] : 'interpolated';
    pushUndo(activeAnn.id, targetKp, kps[targetKp * 3], kps[targetKp * 3 + 1], kps[targetKp * 3 + 2], oldStatus);
    kps[targetKp * 3] = imgPt.x;
    kps[targetKp * 3 + 1] = imgPt.y;
    kps[targetKp * 3 + 2] = 2;
    if (!activeAnn.keypoint_status) activeAnn.keypoint_status = [];
    activeAnn.keypoint_status[targetKp] = 'corrected';
    markModified();
    syncAnnotation(activeAnn);
    state.hoverSource = 'mouse';  // Release sidebar lock after placement
    render();
  }
}

// ── Keyboard Shortcuts ──────────────────────────────────────────
function onKeyDown(e) {
  // Don't intercept when typing in inputs
  if (e.target.tagName === 'INPUT' && e.target.type === 'text') return;

  switch (e.key) {
    case 'ArrowLeft':
      e.preventDefault();
      if (state.currentImageIdx > 0) selectImage(state.currentImageIdx - 1);
      break;
    case 'ArrowRight':
      e.preventDefault();
      if (state.currentImageIdx < state.images.length - 1)
        selectImage(state.currentImageIdx + 1);
      break;
    case 'Delete':
      e.preventDefault();
      deleteKeypoint();
      break;
    case 'Tab':
      e.preventDefault();
      cycleNextKeypoint();
      break;
    case 'r':
    case 'R':
      if (!e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        fitToView();
        render();
      }
      break;
    case 's':
    case 'S':
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        saveAnnotations();
      }
      break;
    case 'z':
    case 'Z':
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        undo();
      }
      break;
    case '+':
    case '=':
      e.preventDefault();
      zoomBy(1.25);
      break;
    case '-':
      e.preventDefault();
      zoomBy(1 / 1.25);
      break;
    case 'm':
    case 'M':
      if (!e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        toggleImageReview();
      }
      break;
    case 'n':
    case 'N':
      if (!e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        jumpToNextUnreviewed();
      }
      break;
    default:
      // Number keys 0–9: select instance
      if (e.key >= '0' && e.key <= '9' && !e.ctrlKey && !e.metaKey) {
        const idx = parseInt(e.key);
        if (idx === 0 && state.annotations.length > 0) {
          // 0 maps to instance 10, or we can use it for instance 1
          // Let's use 1-9 for instances 1-9, 0 for instance 10
          const target = 9; // 0 -> instance 10
          if (target < state.annotations.length) {
            state.activeInstanceIdx = target;
            updateInstanceUI();
            render();
          }
        } else if (idx > 0 && idx <= state.annotations.length) {
          state.activeInstanceIdx = idx - 1;
          updateInstanceUI();
          render();
        }
      }
      break;
  }
}

function deleteKeypoint() {
  if (state.mode === 'review') return;
  const ann = getActiveAnnotation();
  if (!ann) return;
  if (!state.hoveredKp) return; // Delete hovered keypoint
  const kpIdx = state.hoveredKp.kpIdx;
  const kps = ann.keypoints;
  if (kps[kpIdx * 3 + 2] === 0) return;
  const oldStatus = ann.keypoint_status ? ann.keypoint_status[kpIdx] : 'predicted';
  pushUndo(ann.id, kpIdx, kps[kpIdx * 3], kps[kpIdx * 3 + 1], kps[kpIdx * 3 + 2], oldStatus);
  kps[kpIdx * 3 + 2] = 0; // Mark as not annotated
  if (ann.keypoint_status) ann.keypoint_status[kpIdx] = 'interpolated';
  state.hoveredKp = null;
  state.hoverSource = 'mouse';  // Release sidebar lock after delete
  markModified();
  syncAnnotation(ann);
  render();
}

function cycleNextKeypoint() {
  const ann = getActiveAnnotation();
  if (!ann) return;
  const kps = ann.keypoints;
  const numKp = Object.keys(state.config.keypoints || {}).length;
  const start = state.hoveredKp ? state.hoveredKp.kpIdx + 1 : 0;
  for (let k = start; k < numKp; k++) {
    if (kps[k * 3 + 2] !== 0) {
      state.hoveredKp = { annIdx: state.activeInstanceIdx, kpIdx: k };
      render();
      return;
    }
  }
  // Wrap around
  for (let k = 0; k < start; k++) {
    if (kps[k * 3 + 2] !== 0) {
      state.hoveredKp = { annIdx: state.activeInstanceIdx, kpIdx: k };
      render();
      return;
    }
  }
}

function zoomBy(factor) {
  if (!state.imgElement) return;
  const cw = canvas.width / 2;
  const ch = canvas.height / 2;
  const newZoom = Math.max(0.05, Math.min(20, state.zoom * factor));
  state.panX = cw - (cw - state.panX) * (newZoom / state.zoom);
  state.panY = ch - (ch - state.panY) * (newZoom / state.zoom);
  state.zoom = newZoom;
  updateZoomDisplay();
  render();
}

function updateZoomDisplay() {
  zoomDisplay.value = Math.round(state.zoom * 100);
}

// ── Server Sync ──────────────────────────────────────────────────
async function syncAnnotation(ann) {
  try {
    await fetch(`/api/annotations/${ann.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keypoints: ann.keypoints,
        score: ann.score,
        keypoint_status: ann.keypoint_status || [],
      }),
    });
  } catch (e) {
    console.error('Failed to sync annotation:', e);
  }
}

// ── Navigation ───────────────────────────────────────────────────
function updateNavInfo() {
  navInfo.textContent = `${state.currentImageIdx + 1} / ${state.images.length}`;
}

// ── Start ────────────────────────────────────────────────────────
init();
