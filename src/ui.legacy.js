// ui.js — Effects chain panel and parameter editor

const BLEND_MODES = [
  ['source-over', 'Normal'],
  ['lighter',     'Add'],
  ['multiply',    'Multiply'],
  ['screen',      'Screen'],
  ['overlay',     'Overlay'],
  ['difference',  'Difference'],
  ['exclusion',   'Exclusion'],
  ['xor',         'XOR'],
  ['color-dodge', 'Dodge'],
  ['color-burn',  'Burn'],
  ['hard-light',  'Hard Light'],
  ['soft-light',  'Soft Light'],
  ['darken',      'Darken'],
  ['lighten',     'Lighten'],
];

let _chain     = null;
let _registry  = null;
let _selected  = -1;
let _reloadFn      = null;
let _reloadHandFn  = null;
let _reloadPoseFn  = null;

let _sineActive = false;
let _sineSpeed  = 0.3;
let _sineRafId  = null;

// Smooth shuffle animation state
let _smoothAnim = null; // { start, duration, snapshots: [{effect, key, from, to}] }

function _smoothShuffleStart(duration = 1600) {
  _smoothAnim = null; // cancel any running animation
  const snapshots = [];
  for (const effect of _chain) {
    if (effect.locked) continue; // locked FX: skip all params
    for (const [key, def] of Object.entries(effect.params)) {
      if (!def || def.type === 'select' || def.type === 'text' || def.type === 'file') continue;
      if (def.min === undefined || def.max === undefined) continue;
      if (def.noRandom) continue; // param opted out of randomization
      const from = +effect.values[key];
      let to;
      if (def.rndScale !== undefined) {
        const range   = (def.max - def.min) * def.rndScale;
        const raw     = from + (Math.random() * 2 - 1) * range;
        const clamped = Math.min(def.max, Math.max(def.min, raw));
        to = parseFloat((Math.round((clamped - def.min) / def.step) * def.step + def.min).toFixed(6));
      } else {
        const steps = Math.round((def.max - def.min) / def.step);
        to = parseFloat((def.min + Math.round(Math.random() * steps) * def.step).toFixed(6));
      }
      snapshots.push({ effect, key, from, to });
    }
    if (effect._sinePhases) _initSinePhases(effect);
  }
  if (!snapshots.length) return;
  _smoothAnim = { start: performance.now(), duration, snapshots };
  requestAnimationFrame(_smoothAnimFrame);
}

function _smoothAnimFrame(now) {
  if (!_smoothAnim) return;
  const t = Math.min(1, (now - _smoothAnim.start) / _smoothAnim.duration);
  // Ease in-out cubic
  const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  for (const { effect, key, from, to } of _smoothAnim.snapshots) {
    effect.values[key] = from + (to - from) * ease;
  }
  _renderParams();
  if (t < 1) {
    requestAnimationFrame(_smoothAnimFrame);
  } else {
    _smoothAnim = null;
  }
}

// ── Drag state ────────────────────────────────────────────────────────────────
let _dragSrcIdx  = -1;
let _dragGhost   = null;
let _dragOffsetY = 0;

export function initUI(chain, registry, reloadModelFn, reloadHandModelFn, reloadPoseModelFn) {
  _chain        = chain;
  _registry     = registry;
  _reloadFn     = reloadModelFn;
  _reloadHandFn = reloadHandModelFn;
  _reloadPoseFn = reloadPoseModelFn;

  // ── Panel resize ──────────────────────────────────────────────────────────
  const panelEl    = document.getElementById('panel');
  const resizerEl  = document.getElementById('panel-resizer');
  if (panelEl && resizerEl) {
    const saved = localStorage.getItem('panelWidth');
    if (saved) panelEl.style.width = saved + 'px';
    let _rx = 0, _rw = 0;
    resizerEl.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      _rx = e.clientX;
      _rw = panelEl.offsetWidth;
      resizerEl.classList.add('dragging');
      resizerEl.setPointerCapture(e.pointerId);
    });
    resizerEl.addEventListener('pointermove', (e) => {
      if (!resizerEl.classList.contains('dragging')) return;
      const newW = Math.max(240, Math.min(800, _rw - (e.clientX - _rx)));
      panelEl.style.width = newW + 'px';
    });
    resizerEl.addEventListener('pointerup', () => {
      resizerEl.classList.remove('dragging');
      localStorage.setItem('panelWidth', panelEl.offsetWidth);
    });
  }

  // Populate effect-type dropdown
  const select = document.getElementById('effect-type-select');
  for (const EC of registry) {
    const opt = document.createElement('option');
    opt.value       = EC.label;
    opt.textContent = `[${EC.category}] ${EC.label}`;
    select.appendChild(opt);
  }

  document.getElementById('add-effect-btn').addEventListener('click', _addEffect);

  // Face model loading
  document.getElementById('load-model-btn').addEventListener('click', () => {
    document.getElementById('model-file-input').click();
  });
  document.getElementById('model-file-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const buf = new Uint8Array(await file.arrayBuffer());
    await _reloadFn(buf, file.name);
    e.target.value = '';
  });

  // Hand model loading
  document.getElementById('load-hand-model-btn').addEventListener('click', () => {
    document.getElementById('hand-model-file-input').click();
  });
  document.getElementById('hand-model-file-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const buf = new Uint8Array(await file.arrayBuffer());
    await _reloadHandFn(buf, file.name);
    e.target.value = '';
  });

  // Pose model loading
  document.getElementById('load-pose-model-btn').addEventListener('click', () => {
    document.getElementById('pose-model-file-input').click();
  });
  document.getElementById('pose-model-file-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const buf = new Uint8Array(await file.arrayBuffer());
    await _reloadPoseFn(buf, file.name);
    e.target.value = '';
  });

  // Hand FX control toggle
  document.getElementById('hand-fx-control').addEventListener('change', (e) => {
    window.HAND_FX_CONTROL = e.target.checked;
  });
  window.HAND_FX_CONTROL   = false;
  window.MOUSE_FX_CONTROL  = false;
  window.FX_OFFSET         = { x: 0, y: 0 };

  // Hand sensitivity slider
  document.getElementById('hand-sensitivity').addEventListener('input', (e) => {
    window.HAND_FX_SENSITIVITY = parseFloat(e.target.value);
  });
  window.HAND_FX_SENSITIVITY = 1.5;

  // Fingernails mode checkbox
  document.getElementById('fingernails-mode').addEventListener('change', (e) => {
    window.FINGERNAILS_MODE = e.target.checked;
  });
  window.FINGERNAILS_MODE = false;

  // Background removal
  document.getElementById('bg-remove').addEventListener('change', (e) => {
    window.BG_REMOVE = e.target.checked;
  });
  window.BG_REMOVE = false;

  // Preserve landmark data (anti-flicker)
  document.getElementById('preserve-data').addEventListener('change', (e) => {
    window.PRESERVE_DATA = e.target.checked;
  });
  window.PRESERVE_DATA = false;

  // Pixel target mode (face region vs whole screen)
  document.getElementById('pixel-target-mode').addEventListener('change', (e) => {
    window.PIXEL_TARGET_MODE = e.target.value;
  });
  window.PIXEL_TARGET_MODE = 'face';

  // Shuffle order — locked effects stay in place
  document.getElementById('shuffle-order-btn').addEventListener('click', () => {
    const freePos = _chain.map((e, i) => e.locked ? null : i).filter(i => i !== null);
    const freeEfx = freePos.map(i => _chain[i]);
    for (let i = freeEfx.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [freeEfx[i], freeEfx[j]] = [freeEfx[j], freeEfx[i]];
    }
    freePos.forEach((pos, k) => { _chain[pos] = freeEfx[k]; });
    _selected = Math.min(_selected, _chain.length - 1);
    _renderList();
    _renderParams();
  });

  // Randomize selected effect params
  document.getElementById('randomize-sel-btn').addEventListener('click', () => {
    if (_selected >= 0 && _selected < _chain.length) {
      if (!_chain[_selected].locked) {
        _randomizeEffect(_chain[_selected]);
        _renderParams();
      }
    }
  });

  // Randomize all effects params
  document.getElementById('randomize-all-btn').addEventListener('click', () => {
    for (const effect of _chain) if (!effect.locked) _randomizeEffect(effect);
    _renderParams();
  });

  // Smooth shuffle — interpolate all params to new random values over ~1.6s
  document.getElementById('smooth-shuffle-btn').addEventListener('click', () => {
    _smoothShuffleStart();
  });

  // Global animation speed
  document.getElementById('anim-speed').addEventListener('input', (e) => {
    window.ANIM_SPEED = parseFloat(e.target.value);
    document.getElementById('anim-speed-val').textContent = parseFloat(e.target.value).toFixed(2) + 'x';
  });
  window.ANIM_SPEED = 1.0;

  // Sine-wave oscillation
  document.getElementById('sine-toggle-btn').addEventListener('click', () => {
    _sineActive = !_sineActive;
    const btn = document.getElementById('sine-toggle-btn');
    btn.textContent = `🌊 Sine: ${_sineActive ? 'ON' : 'OFF'}`;
    btn.classList.toggle('primary', _sineActive);
    if (_sineActive) {
      for (const effect of _chain) _initSinePhases(effect);
      if (_sineRafId !== null) { cancelAnimationFrame(_sineRafId); _sineRafId = null; }
      _sineLoop();
    } else {
      if (_sineRafId !== null) { cancelAnimationFrame(_sineRafId); _sineRafId = null; }
    }
  });
  document.getElementById('sine-speed').addEventListener('input', (e) => {
    _sineSpeed = parseFloat(e.target.value);
    document.getElementById('sine-speed-val').textContent = parseFloat(e.target.value).toFixed(2);
  });

  // Presets
  document.getElementById('preset-save-btn').addEventListener('click', () => {
    const input = document.getElementById('preset-name-input');
    _savePreset(input.value.trim());
    input.value = '';
  });
  document.getElementById('preset-name-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('preset-save-btn').click();
  });
  _renderPresets();

  _renderList();
  initMovieOverlays();
  _initKeymap();
}

// ── Internal ─────────────────────────────────────────────────────────────────

function _addEffect() {
  const label = document.getElementById('effect-type-select').value;
  const EC = _registry.find(c => c.label === label);
  if (!EC) return;
  const effect = new EC();
  effect.blendMode = 'source-over';
  effect.enabled   = true;
  _chain.push(effect);
  _selected = _chain.length - 1;
  if (_sineActive) _initSinePhases(effect);
  _renderList();
  _renderParams();
}

function _renderList() {
  const list = document.getElementById('effects-list');
  list.innerHTML = '';

  if (_chain.length === 0) {
    list.innerHTML = '<li style="font-size:11px;color:#444;padding:4px 2px;">No effects added yet.</li>';
    return;
  }

  _chain.forEach((effect, idx) => {
    // Blend connector between effects
    if (idx > 0) {
      const conn = document.createElement('li');
      conn.className = 'blend-connector';
      conn.innerHTML = `
        <span class="effect-type-badge BLEND" style="font-size:8px;padding:1px 5px;flex:0 0 auto;">LAYER</span>
        <select class="blend-select" data-blend-idx="${idx}" title="Layer blend mode — how this effect merges with the one below">
          ${BLEND_MODES.map(([val, lbl]) =>
            `<option value="${val}"${effect.blendMode === val ? ' selected' : ''}>${lbl}</option>`
          ).join('')}
        </select>
      `;
      conn.querySelector('select').addEventListener('change', e => {
        _chain[parseInt(e.target.dataset.blendIdx)].blendMode = e.target.value;
      });
      list.appendChild(conn);
    }

    const li = document.createElement('li');
    const enabled = effect.enabled !== false;
    const locked  = effect.locked === true;
    li.className = 'effect-item' + (idx === _selected ? ' selected' : '') + (!enabled ? ' fx-disabled' : '') + (locked ? ' fx-locked' : '');
    li.dataset.dragIdx = idx;
    li.innerHTML = `
      <span class="drag-handle" title="Drag to reorder">⠿</span>
      <div class="effect-info">
        <div class="effect-name">${effect.label}</div>
        <span class="effect-type-badge ${effect.category}">${effect.category}</span>
      </div>
      <div class="reorder-btns">
        <button class="btn-sm" data-action="up"   data-idx="${idx}" title="Move up">▲</button>
        <button class="btn-sm" data-action="down" data-idx="${idx}" title="Move down">▼</button>
      </div>
      <button class="btn-sm${locked ? ' primary' : ''}" data-action="lock" data-idx="${idx}"
        title="${locked ? 'Locked — no randomize, stays in position' : 'Unlocked — click to lock'}"
        style="font-size:11px;padding:0 5px;">${locked ? '🔒' : '🔓'}</button>
      <button class="btn-sm${enabled ? ' primary' : ''}" data-action="toggle" data-idx="${idx}"
        title="${enabled ? 'Enabled — click to disable' : 'Disabled — click to enable'}"
        style="font-size:10px;padding:0 5px;">${enabled ? '●' : '○'}</button>
      <button class="btn-sm" data-action="dup" data-idx="${idx}" title="Duplicate">⧉</button>
      <button class="btn-sm danger" data-action="del" data-idx="${idx}" title="Remove">✕</button>
    `;

    // Drag starts only from the handle
    li.querySelector('.drag-handle').addEventListener('pointerdown', (e) => {
      e.preventDefault();
      _startDrag(idx, li, e);
    });

    li.addEventListener('click', (e) => {
      if (e.target.dataset.action) return;
      _selected = idx;
      _renderList();
      _renderParams();
    });
    li.querySelectorAll('[data-action]').forEach(btn =>
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        _handleAction(e.target.dataset.action, parseInt(e.target.dataset.idx));
      })
    );
    list.appendChild(li);
  });
}

function _handleAction(action, idx) {
  if (action === 'del') {
    _chain.splice(idx, 1);
    if (_selected >= _chain.length) _selected = _chain.length - 1;
  } else if (action === 'toggle') {
    _chain[idx].enabled = !(_chain[idx].enabled !== false);
  } else if (action === 'lock') {
    _chain[idx].locked = !(_chain[idx].locked === true);
  } else if (action === 'dup') {
    const EC = _registry.find(c => c.label === _chain[idx].label);
    if (EC) {
      const clone = new EC();
      clone.values    = { ..._chain[idx].values };
      clone.blendMode = _chain[idx].blendMode ?? 'source-over';
      clone.enabled   = _chain[idx].enabled !== false;
      if (_sineActive) _initSinePhases(clone);
      _chain.splice(idx + 1, 0, clone);
      _selected = idx + 1;
    }
  } else if (action === 'up' && idx > 0) {
    [_chain[idx - 1], _chain[idx]] = [_chain[idx], _chain[idx - 1]];
    if (_selected === idx)          _selected--;
    else if (_selected === idx - 1) _selected++;
  } else if (action === 'down' && idx < _chain.length - 1) {
    [_chain[idx + 1], _chain[idx]] = [_chain[idx], _chain[idx + 1]];
    if (_selected === idx)          _selected++;
    else if (_selected === idx + 1) _selected--;
  }
  _renderList();
  _renderParams();
}

function _randomizeEffect(effect) {
  if (effect.locked) return; // locked FX: no param changes
  for (const [key, def] of Object.entries(effect.params)) {
    if (def.type === 'select' || def.type === 'text' || def.type === 'file') continue;
    if (def.noRandom) continue; // param opted out of randomization
    const steps = Math.round((def.max - def.min) / def.step);
    let newVal;
    if (def.rndScale !== undefined) {
      // Tiny nudge: move at most rndScale fraction of the total range from current value
      const range    = (def.max - def.min) * def.rndScale;
      const cur      = +effect.values[key];
      const raw      = cur + (Math.random() * 2 - 1) * range;
      const clamped  = Math.min(def.max, Math.max(def.min, raw));
      newVal = parseFloat((Math.round((clamped - def.min) / def.step) * def.step + def.min).toFixed(6));
    } else {
      newVal = parseFloat((def.min + Math.round(Math.random() * steps) * def.step).toFixed(6));
    }
    effect.values[key] = newVal;
  }
  // Re-randomise sine phases so motion changes after manual randomize
  if (effect._sinePhases) _initSinePhases(effect);
}

function _renderParams() {
  const panel = document.getElementById('params-panel');
  if (_selected < 0 || _selected >= _chain.length) {
    panel.innerHTML = '<div id="no-params">Select an effect to edit its parameters.</div>';
    return;
  }
  const effect = _chain[_selected];
  if (!effect._sinePinned) effect._sinePinned = {};

  panel.innerHTML = `
    <div style="font-size:12px;color:#aaa;font-weight:bold;margin-bottom:8px;">
      ${effect.label}
      <span class="effect-type-badge ${effect.category}" style="margin-left:6px;">${effect.category}</span>
    </div>
  `;

  // 2-column grid container for slider params; full-width items go in directly
  const grid = document.createElement('div');
  grid.id = 'params-grid';
  panel.appendChild(grid);

  for (const [key, def] of Object.entries(effect.params)) {
    const val = effect.values[key];
    const row = document.createElement('div');
    row.className = 'param-row';

    if (def.type === 'select') {
      row.classList.add('span2');
      const opts = Array.isArray(def.options) ? def.options : [];
      row.innerHTML = `
        <div class="param-label"><span>${def.label}</span></div>
        <select data-key="${key}" style="width:100%;background:#1a2a1a;color:#cde;border:1px solid #2a4a2a;border-radius:4px;padding:3px;">
          ${opts.map(o => {
            const [v, lbl] = Array.isArray(o) ? o : [o, o];
            return `<option value="${v}"${v === val ? ' selected' : ''}>${lbl}</option>`;
          }).join('')}
        </select>
      `;
      row.querySelector('select').addEventListener('change', async (e) => {
        effect.values[key] = e.target.value;
        if (typeof effect.onSelectParam === 'function') await effect.onSelectParam(key, e.target.value);
      });
      grid.appendChild(row);
      continue;
    }

    if (def.type === 'text') {
      row.classList.add('span2');
      row.innerHTML = `
        <div class="param-label"><span>${def.label}</span></div>
        <input type="text" data-key="${key}" value="${(val ?? '').toString().replace(/"/g, '&quot;')}"
          style="width:100%;background:#1a2a1a;color:#cde;border:1px solid #2a4a2a;border-radius:4px;padding:3px 5px;box-sizing:border-box;">
      `;
      row.querySelector('input').addEventListener('input', (e) => {
        effect.values[key] = e.target.value;
      });
      grid.appendChild(row);
      continue;
    }

    if (def.type === 'file') {
      row.classList.add('span2');
      const fname = effect._fileNames?.[key] ?? effect._imgFilename ?? null;
      row.innerHTML = `
        <div class="param-label"><span>${def.label}</span></div>
        <button style="width:100%;background:#1a2a1a;color:#8dc;border:1px solid #2a4a2a;
          border-radius:4px;padding:5px 6px;cursor:pointer;font-size:11px;text-align:left;
          overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${fname ?? ''}">
          ${fname ? `📄 ${fname}` : '📁 Load file…'}
        </button>
        <input type="file" accept="${def.accept ?? 'image/*'}" style="display:none;">
      `;
      const btn  = row.querySelector('button');
      const finp = row.querySelector('input[type="file"]');
      btn.addEventListener('click', () => finp.click());
      finp.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        btn.textContent = `📄 ${file.name}`;
        btn.title = file.name;
        if (!effect._fileNames) effect._fileNames = {};
        effect._fileNames[key] = file.name;
        if (typeof effect.onFileParam === 'function') {
          await effect.onFileParam(key, file);
        } else {
          const reader = new FileReader();
          reader.onload = (re) => {
            const img = new Image();
            img.onload = () => { effect._img = img; effect._puppetInit = false; };
            img.src = re.target.result;
          };
          reader.readAsDataURL(file);
          effect._imgFilename = file.name;
        }
      });
      grid.appendChild(row);
      continue;
    }

    // ── Slider param — goes in 2-col grid cell ────────────────────────────────
    const pinned = !!effect._sinePinned[key];
    row.innerHTML = `
      <div class="param-label" style="font-size:10px;">
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:70%;" title="${def.label}">${def.label}</span>
        <span style="display:flex;align-items:center;gap:3px;flex-shrink:0;">
          <button class="btn-sm" data-pinbtn="${key}" tabindex="-1"
            title="${pinned ? 'Pinned' : 'Pin'}"
            style="font-size:8px;padding:0 2px;line-height:1.6;opacity:${pinned ? 1 : 0.2};">🔒</button>
          <span class="val" id="pval-${key}" style="font-size:9px;">${parseFloat(val).toFixed(2)}</span>
        </span>
      </div>
      <input type="range" min="${def.min}" max="${def.max}" step="${def.step}"
        value="${val}" data-key="${key}"
        style="width:100%;${pinned ? 'accent-color:#cc7e2d;' : ''}">
    `;

    const input  = row.querySelector('input');
    const pinBtn = row.querySelector('[data-pinbtn]');

    input.addEventListener('pointerdown', () => _setPin(effect, key, true, input, pinBtn));
    input.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      effect.values[key] = v;
      row.querySelector(`#pval-${key}`).textContent = v.toFixed(2);
    });
    pinBtn.addEventListener('click', () => _setPin(effect, key, !effect._sinePinned[key], input, pinBtn));

    grid.appendChild(row);
  }
}

function _setPin(effect, key, pin, input, pinBtn) {
  effect._sinePinned[key] = pin;
  pinBtn.style.opacity    = pin ? '1' : '0.2';
  pinBtn.title            = pin ? 'Pinned — click to let sine control' : 'Click to pin';
  input.style.accentColor = pin ? '#cc7e2d' : '#2d7a50';
}

// ── Sine-wave oscillation ─────────────────────────────────────────────────────

function _initSinePhases(effect) {
  effect._sinePhases = {};
  for (const [key, def] of Object.entries(effect.params)) {
    if (def.type === 'select' || def.type === 'text' || def.noRandom) continue;
    effect._sinePhases[key] = Math.random() * Math.PI * 2;
  }
}

function _sineLoop() {
  if (!_sineActive) { _sineRafId = null; return; }
  const t = performance.now() / 1000;
  for (const effect of _chain) {
    if (!effect._sinePhases) _initSinePhases(effect);
    for (const [key, def] of Object.entries(effect.params)) {
      if (effect._sinePinned?.[key]) continue;
      if (def.type === 'select' || def.type === 'text' || def.noRandom) continue;
      const norm  = (Math.sin(t * _sineSpeed + effect._sinePhases[key]) + 1) / 2;
      const steps = Math.round((def.max - def.min) / def.step);
      effect.values[key] = parseFloat((def.min + Math.round(norm * steps) * def.step).toFixed(6));
    }
  }
  _updateParamsUI();
  _sineRafId = requestAnimationFrame(_sineLoop);
}

function _updateParamsUI() {
  if (_selected < 0 || _selected >= _chain.length) return;
  const effect = _chain[_selected];
  const panel  = document.getElementById('params-panel');
  panel.querySelectorAll('input[data-key]').forEach(input => {
    const key = input.dataset.key;
    if (effect.values[key] !== undefined) {
      input.value = effect.values[key];
      const valEl = document.getElementById(`pval-${key}`);
      if (valEl) valEl.textContent = parseFloat(effect.values[key]).toFixed(2);
    }
  });
}

// ── Pointer-based drag reorder ────────────────────────────────────────────────

function _startDrag(srcIdx, srcLi, e) {
  _dragSrcIdx  = srcIdx;
  const rect   = srcLi.getBoundingClientRect();
  _dragOffsetY = e.clientY - rect.top;

  // Floating ghost
  _dragGhost = srcLi.cloneNode(true);
  Object.assign(_dragGhost.style, {
    position:      'fixed',
    left:          rect.left + 'px',
    top:           rect.top  + 'px',
    width:         rect.width + 'px',
    opacity:       '0.85',
    pointerEvents: 'none',
    zIndex:        '9999',
    background:    '#252525',
    border:        '1px dashed #2d7a50',
    borderRadius:  '3px',
    boxShadow:     '0 6px 18px rgba(0,0,0,0.6)',
    transition:    'none',
  });
  document.body.appendChild(_dragGhost);
  srcLi.style.opacity = '0.25';

  window.addEventListener('pointermove', _onDragMove, { passive: true });
  window.addEventListener('pointerup',   _onDragEnd);
}

function _onDragMove(e) {
  if (!_dragGhost) return;
  _dragGhost.style.top = (e.clientY - _dragOffsetY) + 'px';

  // Highlight hovered effect item
  const list  = document.getElementById('effects-list');
  const items = list.querySelectorAll('.effect-item');
  items.forEach(el => el.classList.remove('drag-over'));
  for (const item of items) {
    const r = item.getBoundingClientRect();
    if (e.clientY >= r.top && e.clientY <= r.bottom) {
      if (parseInt(item.dataset.dragIdx) !== _dragSrcIdx) item.classList.add('drag-over');
      break;
    }
  }
}

function _onDragEnd(e) {
  window.removeEventListener('pointermove', _onDragMove);
  window.removeEventListener('pointerup',   _onDragEnd);

  if (_dragGhost) { _dragGhost.remove(); _dragGhost = null; }

  const list  = document.getElementById('effects-list');
  const items = list.querySelectorAll('.effect-item');
  items.forEach(el => el.classList.remove('drag-over'));

  // Find drop target
  let dropIdx = -1;
  for (const item of items) {
    const r = item.getBoundingClientRect();
    if (e.clientY >= r.top && e.clientY <= r.bottom) {
      dropIdx = parseInt(item.dataset.dragIdx);
      break;
    }
  }

  const src = _dragSrcIdx;
  _dragSrcIdx = -1;

  if (dropIdx >= 0 && dropIdx !== src) {
    const [moved] = _chain.splice(src, 1);
    _chain.splice(dropIdx, 0, moved);
    if      (_selected === src)                                        _selected = dropIdx;
    else if (src < dropIdx && _selected > src  && _selected <= dropIdx) _selected--;
    else if (src > dropIdx && _selected < src  && _selected >= dropIdx) _selected++;
  }
  _renderList();
  _renderParams();
}

// ── Presets ───────────────────────────────────────────────────────────────────

const _PRESETS_KEY = 'faceGlitcher_presets';

function _getPresets() {
  try { return JSON.parse(localStorage.getItem(_PRESETS_KEY) || '[]'); } catch { return []; }
}

function _savePresetsToStorage(presets) {
  localStorage.setItem(_PRESETS_KEY, JSON.stringify(presets));
}

function _savePreset(name) {
  const presets  = _getPresets();
  const existing = name ? presets.findIndex(p => p.name === name) : -1;
  const preset   = {
    name:    name || `Preset ${presets.length + 1}`,
    ts:      Date.now(),
    effects: _chain.map(e => ({
      label:      e.label,
      values:     { ...e.values },
      blendMode:  e.blendMode ?? 'source-over',
      enabled:    e.enabled !== false,
      locked:     e.locked  === true,
      sinePinned: { ...(e._sinePinned ?? {}) },
    })),
    // Global settings that affect the visual result
    globalSettings: {
      pixelTargetMode:   window.PIXEL_TARGET_MODE   ?? 'face',
      animSpeed:         window.ANIM_SPEED           ?? 1.0,
      fingernailsMode:   window.FINGERNAILS_MODE     ?? false,
      handFxSensitivity: window.HAND_FX_SENSITIVITY  ?? 1.5,
      sineSpeed:         _sineSpeed,
      bgRemove:          window.BG_REMOVE             ?? false,
      interpSmooth:      window.INTERP_SMOOTH          ?? false,
      preserveData:      window.PRESERVE_DATA          ?? false,
      fastMode:          window.FAST_MODE              ?? false,
      inputFps:          window.INPUT_FPS              ?? 60,
      outputFps:         window.OUTPUT_FPS             ?? 60,
      globalRotSpeed:    window.GLOBAL_ROT_SPEED       ?? 0,
    },
    // Movie overlay layout — positions/sizes saved; videos must be reloaded manually
    movieOverlays: (window.MOVIE_OVERLAYS ?? []).map(ov => ({
      name:    ov.name,
      x:       ov.x,
      y:       ov.y,
      w:       ov.w,
      h:       ov.h,
      opacity: ov.opacity,
      visible: ov.visible,
    })),
  };
  if (existing >= 0) presets[existing] = preset;
  else               presets.unshift(preset);
  _savePresetsToStorage(presets);
  _renderPresets();
}

function _loadPreset(preset) {
  _chain.length = 0;
  for (const saved of preset.effects) {
    const EC = _registry.find(c => c.label === saved.label);
    if (!EC) continue;
    const effect     = new EC();
    effect.values      = { ...effect.values, ...saved.values };
    effect.blendMode   = saved.blendMode ?? 'source-over';
    effect.enabled     = saved.enabled !== false;
    effect.locked      = saved.locked  === true;
    effect._sinePinned = { ...(saved.sinePinned ?? {}) };
    if (_sineActive) _initSinePhases(effect);
    _chain.push(effect);
  }
  _selected = _chain.length > 0 ? 0 : -1;

  // Restore global settings (backward-compatible — old presets won't have this)
  if (preset.globalSettings) {
    const gs = preset.globalSettings;
    if (gs.pixelTargetMode !== undefined) {
      window.PIXEL_TARGET_MODE = gs.pixelTargetMode;
      const el = document.getElementById('pixel-target-mode');
      if (el) el.value = gs.pixelTargetMode;
    }
    if (gs.animSpeed !== undefined) {
      window.ANIM_SPEED = gs.animSpeed;
      const sl = document.getElementById('anim-speed');
      const vl = document.getElementById('anim-speed-val');
      if (sl) sl.value = gs.animSpeed;
      if (vl) vl.textContent = parseFloat(gs.animSpeed).toFixed(2) + 'x';
    }
    if (gs.fingernailsMode !== undefined) {
      window.FINGERNAILS_MODE = gs.fingernailsMode;
      const cb = document.getElementById('fingernails-mode');
      if (cb) cb.checked = gs.fingernailsMode;
    }
    if (gs.handFxSensitivity !== undefined) {
      window.HAND_FX_SENSITIVITY = gs.handFxSensitivity;
      const sl = document.getElementById('hand-sensitivity');
      if (sl) sl.value = gs.handFxSensitivity;
    }
    if (gs.sineSpeed !== undefined) {
      _sineSpeed = gs.sineSpeed;
      const sl = document.getElementById('sine-speed');
      const vl = document.getElementById('sine-speed-val');
      if (sl) sl.value = gs.sineSpeed;
      if (vl) vl.textContent = parseFloat(gs.sineSpeed).toFixed(2);
    }
    if (gs.bgRemove !== undefined) {
      window.BG_REMOVE = gs.bgRemove;
      const cb = document.getElementById('bg-remove');
      if (cb) cb.checked = gs.bgRemove;
    }
    if (gs.interpSmooth !== undefined) {
      window.INTERP_SMOOTH = gs.interpSmooth;
      const cb = document.getElementById('interp-smooth');
      if (cb) cb.checked = gs.interpSmooth;
      if (cb) cb.dispatchEvent(new Event('change'));
    }
    if (gs.preserveData !== undefined) {
      window.PRESERVE_DATA = gs.preserveData;
      const cb = document.getElementById('preserve-data');
      if (cb) cb.checked = gs.preserveData;
    }
    if (gs.fastMode !== undefined) {
      window.FAST_MODE = gs.fastMode;
      const cb = document.getElementById('fast-mode');
      if (cb) cb.checked = gs.fastMode;
      if (cb) cb.dispatchEvent(new Event('change'));
    }
    const _fpsLabel = v => v >= 59 ? 'max' : (v < 1 ? v.toFixed(2) : v % 1 === 0 ? String(v) : v.toFixed(1));
    if (gs.inputFps !== undefined) {
      window.INPUT_FPS = gs.inputFps;
      const sl = document.getElementById('input-fps');
      const vl = document.getElementById('input-fps-val');
      if (sl) sl.value = gs.inputFps;
      if (vl) vl.textContent = _fpsLabel(gs.inputFps) + ' fps';
    }
    if (gs.outputFps !== undefined) {
      window.OUTPUT_FPS = gs.outputFps;
      const sl = document.getElementById('output-fps');
      const vl = document.getElementById('output-fps-val');
      if (sl) sl.value = gs.outputFps;
      if (vl) vl.textContent = _fpsLabel(gs.outputFps) + ' fps';
    }
    if (gs.globalRotSpeed !== undefined) {
      window.GLOBAL_ROT_SPEED = gs.globalRotSpeed;
      const sl = document.getElementById('global-rot-speed');
      const vl = document.getElementById('global-rot-speed-val');
      if (sl) sl.value = gs.globalRotSpeed;
      const lbl = v => v === 0 ? 'off' : (v > 0 ? '+' : '') + v.toFixed(2) + 'x';
      if (vl) vl.textContent = lbl(gs.globalRotSpeed);
    }
  }

  // Restore movie overlay layout by slot index (videos need to be reloaded manually)
  if (preset.movieOverlays && window.MOVIE_OVERLAYS) {
    const overlays = window.MOVIE_OVERLAYS;
    for (let i = 0; i < Math.min(preset.movieOverlays.length, overlays.length); i++) {
      const s = preset.movieOverlays[i];
      if (s.x       !== undefined) overlays[i].x       = s.x;
      if (s.y       !== undefined) overlays[i].y       = s.y;
      if (s.w       !== undefined) overlays[i].w       = s.w;
      if (s.h       !== undefined) overlays[i].h       = s.h;
      if (s.opacity !== undefined) overlays[i].opacity = s.opacity;
      if (s.visible !== undefined) overlays[i].visible = s.visible;
    }
    if (window._renderMovieOverlayUI) window._renderMovieOverlayUI();
  }

  _renderList();
  _renderParams();
}

function _deletePreset(idx) {
  const presets = _getPresets();
  presets.splice(idx, 1);
  _savePresetsToStorage(presets);
  _renderPresets();
}

// ── Movie Overlays ────────────────────────────────────────────────────────────

const _VIDEO_EXTS = /\.(mp4|webm|ogg|mov|avi|mkv|m4v|flv|wmv|3gp)$/i;
function _isVideoFile(f) { return f.type.startsWith('video/') || _VIDEO_EXTS.test(f.name); }

function _addMovieFiles(files) {
  const overlays = window.MOVIE_OVERLAYS;
  let added = 0;
  for (const file of Array.from(files)) {
    if (overlays.length >= 5) break;
    if (!_isVideoFile(file)) continue;
    const url = URL.createObjectURL(file);
    const el  = document.createElement('video');
    el.src       = url;
    el.loop      = true;
    el.muted     = true;
    el.playsInline = true;
    const dW = 320;
    const ov = { el, name: file.name, thumbnail: null,
      x: 20 + overlays.length * 22, y: 20 + overlays.length * 22,
      w: dW, h: 180, opacity: 1.0, visible: true };
    overlays.push(ov);
    el.addEventListener('loadeddata', () => {
      if (el.videoWidth) ov.h = Math.round(dW * el.videoHeight / el.videoWidth);
      try {
        const tc = document.createElement('canvas');
        tc.width = 54; tc.height = 36;
        tc.getContext('2d').drawImage(el, 0, 0, 54, 36);
        ov.thumbnail = tc.toDataURL('image/jpeg', 0.75);
      } catch (_) {}
      _renderMovieOverlayUI();
    }, { once: true });
    el.play().catch(() => {});
    added++;
  }
  if (added) _renderMovieOverlayUI();
}

function _renderMovieOverlayUI() {
  const container = document.getElementById('movie-overlays-list');
  if (!container) return;
  const overlays = window.MOVIE_OVERLAYS ?? [];
  container.innerHTML = '';
  if (overlays.length === 0) {
    container.innerHTML = '<div style="font-size:11px;color:#444;font-style:italic;">No videos loaded (max 5).</div>';
    return;
  }
  for (let i = 0; i < overlays.length; i++) {
    const ov  = overlays[i];
    const sel = window._OVERLAY_SELECTED === i;
    const item = document.createElement('div');
    item.className = 'movie-ov-item' + (sel ? ' selected' : '');

    // Thumbnail
    const thumb = document.createElement('div');
    thumb.style.cssText = 'width:54px;height:36px;flex:0 0 auto;border-radius:2px;background:#0a0a0a;overflow:hidden;display:flex;align-items:center;justify-content:center;';
    if (ov.thumbnail) {
      const img = document.createElement('img');
      img.src = ov.thumbnail;
      img.style.cssText = 'width:54px;height:36px;object-fit:cover;display:block;';
      thumb.appendChild(img);
    } else {
      thumb.innerHTML = '<span style="font-size:16px;color:#333;">🎬</span>';
    }

    // Info + opacity slider
    const info = document.createElement('div');
    info.style.cssText = 'flex:1;min-width:0;';
    const shortName = ov.name.length > 18 ? ov.name.slice(0, 16) + '…' : ov.name;
    info.innerHTML = `
      <div style="font-size:10px;color:#aaa;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${ov.name}">${shortName}</div>
      <div style="font-size:9px;color:#555;margin-top:1px;">${Math.round(ov.w)}×${Math.round(ov.h)}</div>
      <input type="range" min="0" max="1" step="0.01" value="${ov.opacity.toFixed(2)}"
        style="width:100%;margin-top:3px;accent-color:#2d7a50;" title="Opacity">
    `;

    // Action buttons
    const btns = document.createElement('div');
    btns.style.cssText = 'display:flex;flex-direction:column;gap:2px;flex:0 0 auto;';
    btns.innerHTML = `
      <button class="btn-sm${ov.visible ? ' primary' : ''}" data-action="vis"
        style="font-size:9px;padding:1px 4px;" title="${ov.visible ? 'Visible' : 'Hidden'}">${ov.visible ? '👁' : '🙈'}</button>
      <button class="btn-sm" data-action="play"
        style="font-size:9px;padding:1px 4px;" title="Play/Pause">${ov.el.paused ? '▶' : '⏸'}</button>
      <button class="btn-sm danger" data-action="del"
        style="font-size:9px;padding:1px 4px;" title="Remove">✕</button>
    `;

    item.appendChild(thumb);
    item.appendChild(info);
    item.appendChild(btns);

    // Timeline scrubber — added below the main row
    const tlRow = document.createElement('div');
    tlRow.style.cssText = 'width:100%;padding:2px 0 0 0;';
    const dur = isFinite(ov.el.duration) && ov.el.duration > 0 ? ov.el.duration : 1;
    const cur = ov.el.currentTime || 0;
    const _fmt = s => { const m = (s/60)|0; return `${m}:${String((s|0)%60).padStart(2,'0')}`; };
    const tlSlider = document.createElement('input');
    tlSlider.type = 'range'; tlSlider.min = 0; tlSlider.max = dur; tlSlider.step = 0.05;
    tlSlider.value = cur;
    tlSlider.title = 'Timeline';
    tlSlider.style.cssText = 'width:100%;margin:0;accent-color:#7a4a2d;';
    const tlTime = document.createElement('span');
    tlTime.style.cssText = 'font-size:9px;color:#555;display:flex;justify-content:space-between;';
    tlTime.innerHTML = `<span id="ov-time-${i}">${_fmt(cur)}</span><span>${_fmt(dur)}</span>`;
    tlRow.appendChild(tlSlider);
    tlRow.appendChild(tlTime);

    // Wrap item+timeline in a block div
    const block = document.createElement('div');
    block.style.cssText = 'margin-bottom:6px;';
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:5px;';
    row.appendChild(thumb);
    row.appendChild(info);
    row.appendChild(btns);
    block.appendChild(row);
    block.appendChild(tlRow);
    container.appendChild(block);

    // Remove old timeupdate listener if present
    if (ov._timeUpdateFn) ov.el.removeEventListener('timeupdate', ov._timeUpdateFn);
    ov._timeUpdateFn = () => {
      if (tlSlider.dataset.dragging) return;
      const d = isFinite(ov.el.duration) && ov.el.duration > 0 ? ov.el.duration : 1;
      tlSlider.max = d;
      tlSlider.value = ov.el.currentTime;
      const tc = document.getElementById(`ov-time-${i}`);
      if (tc) tc.textContent = _fmt(ov.el.currentTime);
    };
    ov.el.addEventListener('timeupdate', ov._timeUpdateFn);

    // Scrub
    tlSlider.addEventListener('pointerdown', () => { tlSlider.dataset.dragging = '1'; });
    tlSlider.addEventListener('pointerup',   () => { delete tlSlider.dataset.dragging; });
    tlSlider.addEventListener('input', (e) => {
      e.stopPropagation();
      ov.el.currentTime = parseFloat(e.target.value);
      const tc = document.getElementById(`ov-time-${i}`);
      if (tc) tc.textContent = _fmt(ov.el.currentTime);
    });
    tlSlider.addEventListener('click', (e) => e.stopPropagation());

    // Select on click (row only)
    row.addEventListener('click', (e) => {
      if (e.target.dataset.action || e.target.tagName === 'INPUT') return;
      window._OVERLAY_SELECTED = (window._OVERLAY_SELECTED === i) ? -1 : i;
      _renderMovieOverlayUI();
    });

    // Opacity slider
    const opSlider = info.querySelector('input[type="range"]');
    opSlider.addEventListener('input', (e) => { ov.opacity = parseFloat(e.target.value); });
    opSlider.addEventListener('click', (e) => e.stopPropagation());

    // Buttons
    btns.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (btn.dataset.action === 'vis') {
          ov.visible = !ov.visible;
          _renderMovieOverlayUI();
        } else if (btn.dataset.action === 'play') {
          if (ov.el.paused) ov.el.play().catch(() => {});
          else              ov.el.pause();
          setTimeout(_renderMovieOverlayUI, 150);
        } else if (btn.dataset.action === 'del') {
          if (ov._timeUpdateFn) ov.el.removeEventListener('timeupdate', ov._timeUpdateFn);
          URL.revokeObjectURL(ov.el.src);
          ov.el.pause();
          overlays.splice(i, 1);
          if (window._OVERLAY_SELECTED >= overlays.length) window._OVERLAY_SELECTED = overlays.length - 1;
          _renderMovieOverlayUI();
        }
      });
    });
  }
}

function initMovieOverlays() {
  window._renderMovieOverlayUI = _renderMovieOverlayUI;
  document.getElementById('movie-folder-btn').addEventListener('click', () =>
    document.getElementById('movie-folder-input').click());
  document.getElementById('movie-files-btn').addEventListener('click', () =>
    document.getElementById('movie-files-input').click());
  document.getElementById('movie-folder-input').addEventListener('change', (e) => {
    _addMovieFiles(e.target.files);
    e.target.value = '';
  });
  document.getElementById('movie-files-input').addEventListener('change', (e) => {
    _addMovieFiles(e.target.files);
    e.target.value = '';
  });
  document.getElementById('movie-clear-btn').addEventListener('click', () => {
    for (const ov of window.MOVIE_OVERLAYS) { ov.el.pause(); URL.revokeObjectURL(ov.el.src); }
    window.MOVIE_OVERLAYS.length = 0;
    window._OVERLAY_SELECTED = -1;
    _renderMovieOverlayUI();
  });
  _renderMovieOverlayUI();
}

function _renderPresets() {
  const container = document.getElementById('presets-list');
  const presets   = _getPresets();
  container.innerHTML = '';
  if (presets.length === 0) {
    container.innerHTML = '<div style="font-size:11px;color:#444;font-style:italic;">No presets saved yet.</div>';
    return;
  }
  for (let i = 0; i < presets.length; i++) {
    const preset = presets[i];
    const row    = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:4px;margin-bottom:4px;';

    const nameBtn = document.createElement('button');
    nameBtn.textContent   = preset.name;
    nameBtn.title         = `Load "${preset.name}" (${preset.effects.length} effects)`;
    nameBtn.style.cssText = 'flex:1;text-align:left;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    nameBtn.addEventListener('click', () => _loadPreset(preset));

    const delBtn     = document.createElement('button');
    delBtn.textContent = '✕';
    delBtn.className   = 'btn-sm danger';
    delBtn.title       = 'Delete preset';
    delBtn.addEventListener('click', () => _deletePreset(i));

    row.appendChild(nameBtn);
    row.appendChild(delBtn);
    container.appendChild(row);
  }
}

// -- Keyboard HUD in panel ---------------------------------------------------

let _kbdHudTimer = null;
function _showKbdHUD(text) {
  const el = document.getElementById('kbd-hud');
  if (!el) return;
  el.textContent = text;
  el.style.color = '#9ddbb0';
  clearTimeout(_kbdHudTimer);
  _kbdHudTimer = setTimeout(() => { if (el) el.style.color = '#7eaacc'; }, 2000);
}

// Populate key-map reference grid
function _initKeymap() {
  const el = document.getElementById('kbd-keymap');
  if (!el) return;
  const MAP = [
    ['1','Smooth shuffle'],['2','Nudge −2%'],['3','Nudge +2%'],['4','Mini morph'],
    ['5','Glow boost'],['6','Color cycle'],['7','Reorder'],['8','Tempo burst'],
    ['9','Reset defaults'],['0','Full chaos'],
    ['q','Nudge −1%'],['e','Nudge +1%'],['w','Warp geometry'],['r','Rnd. selected'],
    ['t','Tint shift'],['y','Yank snap'],['u','Unstash snap'],['i','Invert params'],
    ['o','Opacity −10%'],['p','Opacity +10%'],
    ['a','Add rnd. fx'],['s','Sine toggle'],['d','Del. last fx'],['f','Flip colors'],
    ['g','Glitch burst'],['h','Hue rotate'],['j','Jitter ±1%'],['k','Kill all'],
    ['l','Lock selected'],['m','Big morph 30%'],
    ['z','Undo remove'],['x','Remove last'],['c','Invert colors'],['v','Vignette'],
    ['b','Blur boost'],['n','Noise burst'],
  ];
  el.innerHTML = MAP.map(([k, lbl]) => `<span><b style="color:#555">${k}</b> <span style="color:#383838">${lbl}</span></span>`).join('');
}

// Per-key state
let _kbdSnap = null;   // y/u: yank/unstash snapshot
let _kbdUndo = null;   // z: undo-remove

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
  if (!_chain) return;
  const active = _chain.filter(ef => ef.enabled !== false);
  const free   = active.filter(ef => !ef.locked);

  // Helper: nudge a single numeric range param
  const _nudgeAll = (pct) => {
    for (const ef of free) for (const [key, def] of Object.entries(ef.params)) {
      if (def.noRandom || def.min === undefined) continue;
      ef.values[key] = Math.max(def.min, Math.min(def.max, +ef.values[key] + (def.max - def.min) * pct));
    }
    _renderParams();
  };

  switch (e.key) {
    // ── Number row ─────────────────────────────────────────────────────────
    case '1': { _smoothShuffleStart(1200); _showKbdHUD('1 - Smooth Shuffle'); break; }
    case '2': { _nudgeAll(-0.02); _showKbdHUD('2 - Nudge all −2%'); break; }
    case '3': { _nudgeAll(+0.02); _showKbdHUD('3 - Nudge all +2%'); break; }
    case '4': {
      for (const ef of free) for (const [key, def] of Object.entries(ef.params)) {
        if (def.noRandom || def.min === undefined) continue;
        const n = (Math.random() * 2 - 1) * (def.max - def.min) * 0.05;
        ef.values[key] = Math.max(def.min, Math.min(def.max, +ef.values[key] + n));
      }
      _renderParams(); _showKbdHUD('4 - Mini Morph ±5%'); break;
    }
    case '5': {
      for (const ef of free) for (const [key, def] of Object.entries(ef.params)) {
        if (def.min === undefined) continue;
        const lbl = (def.label || key).toLowerCase();
        if (lbl.includes('glow') || lbl.includes('blur') || lbl.includes('shadow') || lbl.includes('bloom'))
          ef.values[key] = Math.min(def.max, +ef.values[key] + (def.max - def.min) * 0.18);
      }
      _renderParams(); _showKbdHUD('5 - Glow Boost'); break;
    }
    case '6': {
      for (const ef of free) {
        if (ef.params.r && ef.params.g && ef.params.b) {
          const oR = +ef.values.r, oG = +ef.values.g, oB = +ef.values.b;
          ef.values.r = Math.min(255, Math.max(0, oG + (Math.random() * 30 - 15)));
          ef.values.g = Math.min(255, Math.max(0, oB + (Math.random() * 30 - 15)));
          ef.values.b = Math.min(255, Math.max(0, oR + (Math.random() * 30 - 15)));
        }
      }
      _renderParams(); _showKbdHUD('6 - Color Cycle'); break;
    }
    case '7': {
      const freePos7 = _chain.map((ef, i) => ef.locked ? null : i).filter(i => i !== null);
      const freeEfx7 = freePos7.map(i => _chain[i]);
      for (let i = freeEfx7.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [freeEfx7[i], freeEfx7[j]] = [freeEfx7[j], freeEfx7[i]];
      }
      freePos7.forEach((pos, k) => { _chain[pos] = freeEfx7[k]; });
      _renderList(); _renderParams(); _showKbdHUD('7 - Reorder Chain'); break;
    }
    case '8': {
      const snaps = [];
      for (const ef of free) for (const [key, def] of Object.entries(ef.params)) {
        if (def.min === undefined || def.noRandom) continue;
        const lbl = (def.label || key).toLowerCase();
        if (lbl.includes('speed') || lbl.includes('rate') || lbl.includes('freq') || lbl.includes('tempo'))
          snaps.push({ effect: ef, key, from: def.max, to: +ef.values[key] });
      }
      if (snaps.length) {
        for (const s of snaps) s.effect.values[s.key] = s.from;
        _renderParams();
        _smoothAnim = { start: performance.now(), duration: 1500, snapshots: snaps };
        requestAnimationFrame(_smoothAnimFrame);
      }
      _showKbdHUD('8 - Tempo Burst'); break;
    }
    case '9': {
      for (const ef of free) for (const [key, def] of Object.entries(ef.params))
        if (def.default !== undefined) ef.values[key] = def.default;
      _renderParams(); _showKbdHUD('9 - Reset to Defaults'); break;
    }
    case '0': {
      // Full chaos: remove unlocked effects and add 3–5 random ones
      if (!_registry) break;
      _kbdUndo = _chain.filter(ef => !ef.locked).map(ef => ({EC: ef.constructor, vals: {...ef.values}}));
      for (let i = _chain.length - 1; i >= 0; i--)
        if (!_chain[i].locked) _chain.splice(i, 1);
      const n = 3 + Math.floor(Math.random() * 3);
      for (let k = 0; k < n; k++) {
        const EC = _registry[Math.floor(Math.random() * _registry.length)];
        const ef = new EC(); ef.enabled = true; ef.blendMode = 'source-over'; _chain.push(ef);
        _randomizeEffect(ef);
      }
      _selected = _chain.length - 1;
      _smoothShuffleStart(1500);
      _renderList(); _renderParams(); _showKbdHUD('0 - Full Chaos'); break;
    }

    // ── Letter keys (only when chain not empty or can add) ──────────────
    case 'q': { _nudgeAll(-0.01); _showKbdHUD('q - Nudge −1%'); break; }
    case 'e': { _nudgeAll(+0.01); _showKbdHUD('e - Nudge +1%'); break; }
    case 'w': {
      // Warp: randomize shape/geometry params only
      for (const ef of free) for (const [key, def] of Object.entries(ef.params)) {
        if (def.noRandom || def.min === undefined) continue;
        const lbl = (def.label || key).toLowerCase();
        if (lbl.match(/warp|jitter|bend|wave|distort|freq|amplitude|scale|size|radius|expand|shift|offset/)) {
          ef.values[key] = def.min + Math.random() * (def.max - def.min);
        }
      }
      _renderParams(); _showKbdHUD('w - Warp Geometry'); break;
    }
    case 'r': {
      if (!_chain.length) break;
      const sel = _chain[Math.min(_selected ?? 0, _chain.length - 1)];
      if (sel && !sel.locked) _randomizeEffect(sel);
      _renderParams(); _showKbdHUD('r - Rnd. Selected Effect'); break;
    }
    case 't': {
      // Tint: random hue offset to all r/g/b params
      const shift = (Math.random() - 0.5) * 80;
      for (const ef of free) {
        for (const k of ['r', 'g', 'b', 'hue']) {
          if (ef.params[k] && ef.params[k].min !== undefined) {
            const d = ef.params[k];
            ef.values[k] = Math.max(d.min, Math.min(d.max, +ef.values[k] + shift));
          }
        }
      }
      _renderParams(); _showKbdHUD('t - Tint Shift'); break;
    }
    case 'y': {
      // Yank: snapshot all free effect values
      _kbdSnap = free.map(ef => ({ ef, vals: {...ef.values} }));
      _showKbdHUD(`y - Snapped ${_kbdSnap.length} effects`); break;
    }
    case 'u': {
      // Unstash: restore snapshot
      if (!_kbdSnap) { _showKbdHUD('u - No snapshot!'); break; }
      for (const { ef, vals } of _kbdSnap) {
        if (_chain.includes(ef)) Object.assign(ef.values, vals);
      }
      _renderParams(); _showKbdHUD('u - Unstashed Snapshot'); break;
    }
    case 'i': {
      // Invert all 0–1 normalized params (flip slider)
      for (const ef of free) for (const [key, def] of Object.entries(ef.params)) {
        if (def.noRandom || def.min === undefined) continue;
        const norm = (+ef.values[key] - def.min) / (def.max - def.min);
        ef.values[key] = def.min + (1 - norm) * (def.max - def.min);
      }
      _renderParams(); _showKbdHUD('i - Invert Params'); break;
    }
    case 'o': {
      for (const ef of free) {
        if (ef.params.opacity) ef.values.opacity = Math.max(0, +ef.values.opacity - 10);
        else if (ef.params.alpha) ef.values.alpha = Math.max(0, +ef.values.alpha - 25);
      }
      _renderParams(); _showKbdHUD('o - Opacity −10%'); break;
    }
    case 'p': {
      for (const ef of free) {
        if (ef.params.opacity) ef.values.opacity = Math.min(ef.params.opacity.max, +ef.values.opacity + 10);
        else if (ef.params.alpha) ef.values.alpha = Math.min(ef.params.alpha.max, +ef.values.alpha + 25);
      }
      _renderParams(); _showKbdHUD('p - Opacity +10%'); break;
    }
    case 'a': {
      if (!_registry) break;
      const EC = _registry[Math.floor(Math.random() * _registry.length)];
      const ef = new EC(); ef.enabled = true; ef.blendMode = 'source-over'; _chain.push(ef);
      _randomizeEffect(ef);
      _selected = _chain.length - 1;
      _renderList(); _renderParams(); _showKbdHUD(`a - Added ${EC.label}`); break;
    }
    case 's': {
      // Toggle sine automation
      document.getElementById('sine-toggle-btn')?.click();
      _showKbdHUD('s - Sine Toggle'); break;
    }
    case 'd': {
      // Delete last unlocked effect
      const idx = [..._chain.keys()].reverse().find(i => !_chain[i].locked);
      if (idx !== undefined) {
        _kbdUndo = [{ EC: _chain[idx].constructor, vals: {..._chain[idx].values}, idx }];
        _chain.splice(idx, 1);
        _selected = Math.min(_selected ?? 0, _chain.length - 1);
        _renderList(); _renderParams(); _showKbdHUD('d - Deleted Last FX');
      } break;
    }
    case 'f': {
      // Flip: negate all r/g/b (255-v)
      for (const ef of free) {
        for (const k of ['r', 'g', 'b']) {
          if (ef.params[k] && ef.params[k].max === 255) ef.values[k] = 255 - +ef.values[k];
        }
      }
      _renderParams(); _showKbdHUD('f - Flip Colors'); break;
    }
    case 'g': {
      // Glitch burst: push glitch/noise/chroma params to max, then smooth back
      const snapsG = [];
      for (const ef of free) for (const [key, def] of Object.entries(ef.params)) {
        if (def.min === undefined || def.noRandom) continue;
        const lbl = (def.label || key).toLowerCase();
        if (lbl.match(/glitch|noise|chroma|aberr|displace|jitter|scatter/)) {
          snapsG.push({ effect: ef, key, from: def.max, to: +ef.values[key] });
          ef.values[key] = def.max;
        }
      }
      _renderParams();
      if (snapsG.length) {
        _smoothAnim = { start: performance.now(), duration: 1200, snapshots: snapsG };
        requestAnimationFrame(_smoothAnimFrame);
      }
      _showKbdHUD('g - Glitch Burst'); break;
    }
    case 'h': {
      // Hue rotate: cycle hue/r/g/b params by 60° equivalent
      for (const ef of free) for (const [key, def] of Object.entries(ef.params)) {
        if (def.min === undefined) continue;
        const lbl = (def.label || key).toLowerCase();
        if (!lbl.match(/hue|tint|r$|g$|b$/)) continue;
        const range = def.max - def.min;
        ef.values[key] = def.min + ((+ef.values[key] - def.min + range * 0.167) % range);
      }
      _renderParams(); _showKbdHUD('h - Hue Rotate +60°'); break;
    }
    case 'j': {
      // Jitter ±1% micro-nudge
      for (const ef of free) for (const [key, def] of Object.entries(ef.params)) {
        if (def.noRandom || def.min === undefined) continue;
        const n = (Math.random() * 2 - 1) * (def.max - def.min) * 0.01;
        ef.values[key] = Math.max(def.min, Math.min(def.max, +ef.values[key] + n));
      }
      _renderParams(); _showKbdHUD('j - Jitter ±1%'); break;
    }
    case 'k': {
      // Kill all effects (disable them all, keeping them in chain)
      for (const ef of _chain) ef.enabled = false;
      _renderList(); _showKbdHUD('k - All Effects Off'); break;
    }
    case 'l': {
      // Lock/unlock selected effect
      if (!_chain.length) break;
      const selEf = _chain[Math.min(_selected ?? 0, _chain.length - 1)];
      if (selEf) { selEf.locked = !selEf.locked; _renderList(); _showKbdHUD(`l - ${selEf.locked ? 'Locked' : 'Unlocked'} ${selEf.constructor.label}`); }
      break;
    }
    case 'm': {
      // Big morph: smooth nudge ±30% over 2s
      const snapsM = [];
      for (const ef of free) for (const [key, def] of Object.entries(ef.params)) {
        if (def.noRandom || def.min === undefined) continue;
        const target = def.min + Math.random() * (def.max - def.min);
        snapsM.push({ effect: ef, key, from: +ef.values[key], to: target });
      }
      if (snapsM.length) {
        for (const s of snapsM) s.effect.values[s.key] = s.from;
        _smoothAnim = { start: performance.now(), duration: 2000, snapshots: snapsM };
        requestAnimationFrame(_smoothAnimFrame);
      }
      _showKbdHUD('m - Big Morph 2s'); break;
    }
    case 'b': {
      for (const ef of free) for (const [key, def] of Object.entries(ef.params)) {
        if (def.min === undefined) continue;
        const lbl = (def.label || key).toLowerCase();
        if (lbl.includes('blur') || lbl.includes('soft'))
          ef.values[key] = Math.min(def.max, +ef.values[key] + (def.max - def.min) * 0.15);
      }
      _renderParams(); _showKbdHUD('b - Blur Boost'); break;
    }
    case 'n': {
      const snapsN = [];
      for (const ef of free) for (const [key, def] of Object.entries(ef.params)) {
        if (def.min === undefined || def.noRandom) continue;
        const lbl = (def.label || key).toLowerCase();
        if (lbl.includes('noise') || lbl.includes('grain') || lbl.includes('static'))
          snapsN.push({ effect: ef, key, from: def.max, to: +ef.values[key] });
      }
      if (snapsN.length) {
        for (const s of snapsN) s.effect.values[s.key] = s.from;
        _renderParams();
        _smoothAnim = { start: performance.now(), duration: 1000, snapshots: snapsN };
        requestAnimationFrame(_smoothAnimFrame);
      }
      _showKbdHUD('n - Noise Burst'); break;
    }
    case 'v': {
      // Add Vignette effect (or remove if last effect is Vignette)
      if (!_registry) break;
      const VigClass = _registry.find(EC => EC.label === 'Vignette');
      if (!VigClass) break;
      const last = _chain[_chain.length - 1];
      if (last && last.constructor.label === 'Vignette') {
        _kbdUndo = [{ EC: last.constructor, vals: {...last.values}, idx: _chain.length - 1 }];
        _chain.pop(); _showKbdHUD('v - Removed Vignette');
      } else {
        const ef = new VigClass(); ef.enabled = true; ef.blendMode = 'source-over'; _chain.push(ef);
        _showKbdHUD('v - Added Vignette');
      }
      _renderList(); _renderParams(); break;
    }
    case 'c': {
      // Canvas colour invert (post-process): push a colour shift to invert everything
      for (const ef of free) for (const [key, def] of Object.entries(ef.params)) {
        if (def.min === undefined) continue;
        const lbl = (def.label || key).toLowerCase();
        if (lbl.match(/invert|negate|flip/)) ef.values[key] = def.max - (+ef.values[key] - def.min);
      }
      _renderParams(); _showKbdHUD('c - Color Invert Toggle'); break;
    }
    case 'x': {
      // Remove last effect
      if (!_chain.length) break;
      const last = _chain[_chain.length - 1];
      if (last.locked) { _showKbdHUD('x - Last FX is locked'); break; }
      _kbdUndo = [{ EC: last.constructor, vals: {...last.values}, idx: _chain.length - 1 }];
      _chain.pop(); _selected = Math.max(0, _chain.length - 1);
      _renderList(); _renderParams(); _showKbdHUD('x - Removed Last FX'); break;
    }
    case 'z': {
      // Undo last remove (d/x/0)
      if (!_kbdUndo) { _showKbdHUD('z - Nothing to undo'); break; }
      for (const rec of _kbdUndo) {
        const ef = new rec.EC(); ef.enabled = true; ef.blendMode = 'source-over';
        Object.assign(ef.values, rec.vals);
        const insertIdx = rec.idx !== undefined ? Math.min(rec.idx, _chain.length) : _chain.length;
        _chain.splice(insertIdx, 0, ef);
      }
      _kbdUndo = null;
      _renderList(); _renderParams(); _showKbdHUD('z - Undo Restore'); break;
    }
  }
});