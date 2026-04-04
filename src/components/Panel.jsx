// Panel.jsx — Tabbed control panel with hide toggle
import { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react'
import { EFFECT_REGISTRY } from '../effects'

const BLEND_MODES = [
  ['source-over','Normal'],['lighter','Add'],['multiply','Multiply'],['screen','Screen'],
  ['overlay','Overlay'],['difference','Difference'],['exclusion','Exclusion'],['xor','XOR'],
  ['color-dodge','Dodge'],['color-burn','Burn'],['hard-light','Hard Light'],
  ['soft-light','Soft Light'],['darken','Darken'],['lighten','Lighten'],
]

const PRESETS_KEY = 'faceGlitcher_presets'
const getPresets  = () => { try { return JSON.parse(localStorage.getItem(PRESETS_KEY) || '[]') } catch { return [] } }
const savePresets = (p) => localStorage.setItem(PRESETS_KEY, JSON.stringify(p))

function defaults(params) {
  const v = {}
  for (const [k, d] of Object.entries(params)) v[k] = d.default ?? 0
  return v
}

function randomizeEffect(effect) {
  if (effect.locked) return
  for (const [key, def] of Object.entries(effect.params)) {
    if (effect._sinePinned?.[key]) continue
    if (def.type === 'select' || def.type === 'text' || def.type === 'file' || def.noRandom) continue
    const steps = Math.round((def.max - def.min) / def.step)
    let newVal
    if (def.rndScale !== undefined) {
      const range = (def.max - def.min) * def.rndScale
      const cur   = +effect.values[key]
      const raw   = cur + (Math.random() * 2 - 1) * range
      newVal = parseFloat((Math.min(def.max, Math.max(def.min, raw))).toFixed(6))
    } else {
      newVal = parseFloat((def.min + Math.round(Math.random() * steps) * def.step).toFixed(6))
    }
    effect.values[key] = newVal
  }
}

// ── Tab definitions ────────────────────────────────────────────────────────────
const TABS = [
  { id: 'video',    icon: '📷', label: 'VIDEO'   },
  { id: 'effects',  icon: '✦',  label: 'FX'      },
  { id: 'random',   icon: '🎲', label: 'RAND'    },
  { id: 'detect',   icon: '👁',  label: 'ML'      },
  { id: 'output',   icon: '⚙',  label: 'OUT'     },
  { id: 'audio',    icon: '🎵', label: 'AUDIO'   },
  { id: 'more',     icon: '☰',  label: 'MORE'    },
]

function Check({ label, checked, onChange }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
      {label}
    </label>
  )
}

function ModelRow({ label, status, ready, onLoad }) {
  const fileRef = useRef(null)
  return (
    <div className="model-row">
      <span className={`dot ${ready ? 'ready' : ''}`} />
      <span style={{ flex: 1, fontSize: 11 }}>{status}</span>
      <button style={{ fontSize: 10 }} onClick={() => fileRef.current?.click()}>Load</button>
      <input ref={fileRef} type="file" accept=".task" style={{ display: 'none' }}
        onChange={async e => {
          const file = e.target.files?.[0]; if (!file) return
          const buf = await file.arrayBuffer()
          await onLoad(new Uint8Array(buf), file.name)
          e.target.value = ''
        }} />
    </div>
  )
}

// ParamsEditor — fully uncontrolled, zero React re-renders during slider drag
// Values live in effect.values (plain JS object), canvas reads them directly.
// We only touch React state for structural changes (pin/rndSine toggle, select, file).
function ParamsEditor({ effect, onChange, onRndSineChanged }) {
  const [pinVer, setPinVer] = useState(0)   // only re-render when pin/rndSine state changes
  const labelRefs  = useRef({})             // span elements showing numeric value
  const sliderRefs = useRef({})             // range input elements (for sine/smooth updates)

  // Expose slider + label refs on effect so sine/smooth loops can update them directly
  useEffect(() => {
    effect._sliderEls = sliderRefs.current
    effect._labelEls  = labelRefs.current
    return () => { delete effect._sliderEls; delete effect._labelEls }
  })

  if (!Object.keys(effect.params).length)
    return <div className="hint" style={{ padding: '4px 0' }}>No params.</div>

  return (
    <div>
      <div className="params-grid">
        {Object.entries(effect.params).map(([key, def]) => {
          const val = effect.values[key]

          if (def.type === 'select') return (
            <div key={key} className="param-row span2">
              <div className="param-label">{def.label}</div>
              <select defaultValue={val ?? def.default}
                onChange={async e => {
                  effect.values[key] = e.target.value
                  if (effect.onSelectParam) await effect.onSelectParam(key, e.target.value)
                  onChange()
                }}>
                {(Array.isArray(def.options) ? def.options : []).map(o => {
                  const [v, l] = Array.isArray(o) ? o : [o, o]
                  return <option key={v} value={v}>{l}</option>
                })}
              </select>
            </div>
          )

          if (def.type === 'text') return (
            <div key={key} className="param-row span2">
              <div className="param-label">{def.label}</div>
              <input type="text" defaultValue={(val ?? '').toString()}
                onBlur={e => { effect.values[key] = e.target.value; onChange() }}
                style={{ width: '100%' }} />
            </div>
          )

          if (def.type === 'file') return (
            <div key={key} className="param-row span2">
              <div className="param-label">{def.label}</div>
              <label className="btn-file" style={{ width: '100%', boxSizing: 'border-box' }}>
                {effect._fileNames?.[key] ? `📄 ${effect._fileNames[key]}` : '📁 Load…'}
                <input type="file" accept={def.accept ?? 'image/*'} style={{ display: 'none' }}
                  onChange={async e => {
                    const file = e.target.files?.[0]; if (!file) return
                    if (!effect._fileNames) effect._fileNames = {}
                    effect._fileNames[key] = file.name
                    if (effect.onFileParam) await effect.onFileParam(key, file)
                    else {
                      const reader = new FileReader()
                      reader.onload = re => {
                        const img = new Image()
                        img.onload = () => { effect._img = img; effect._puppetInit = false }
                        img.src = re.target.result
                      }
                      reader.readAsDataURL(file)
                      effect._imgFilename = file.name
                    }
                    onChange()
                  }} />
              </label>
            </div>
          )

          const pinned  = !!effect._sinePinned?.[key]
          const rndSine = !!effect._rndSine?.[key]
          const accentColor = rndSine ? '#4db8ff' : pinned ? '#cc7e2d' : '#2d7a50'
          return (
            <div key={key} className="param-row">
              <div className="param-label">
                <span title={def.label}>{def.label}</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                  <button style={{ fontSize: 9, padding: '0 2px', opacity: rndSine ? 1 : 0.3, color: rndSine ? '#4db8ff' : undefined }}
                    title={rndSine ? 'Per-slider sine ON — click to stop' : 'Sine this slider independently'}
                    onClick={() => {
                      if (!effect._rndSine)      effect._rndSine      = {}
                      if (!effect._rndSinePhase) effect._rndSinePhase = {}
                      if (!effect._rndSineFreq)  effect._rndSineFreq  = {}
                      const next = !rndSine
                      effect._rndSine[key] = next
                      if (next) {
                        effect._rndSinePhase[key] = Math.random() * Math.PI * 2
                        effect._rndSineFreq[key]  = 0.4 + Math.random() * 2.2
                      }
                      if (sliderRefs.current[key]) sliderRefs.current[key].style.accentColor = next ? '#4db8ff' : pinned ? '#cc7e2d' : '#2d7a50'
                      setPinVer(v => v + 1)
                      onRndSineChanged?.()
                    }}>≋</button>
                  <button style={{ fontSize: 8, padding: '0 2px', opacity: pinned ? 1 : 0.25 }}
                    onClick={() => {
                      if (!effect._sinePinned) effect._sinePinned = {}
                      effect._sinePinned[key] = !pinned
                      if (sliderRefs.current[key]) sliderRefs.current[key].style.accentColor = !pinned ? '#cc7e2d' : '#2d7a50'
                      setPinVer(v => v + 1)
                    }}>🔒</button>
                  <span ref={el => { labelRefs.current[key] = el }}
                    style={{ fontSize: 9 }}>{parseFloat(val).toFixed(2)}</span>
                </span>
              </div>
              <input type="range" min={def.min} max={def.max} step={def.step}
                defaultValue={val}
                ref={el => { sliderRefs.current[key] = el }}
                style={{ width: '100%', accentColor }}
                onPointerDown={() => {
                  if (!effect._sinePinned) effect._sinePinned = {}
                  effect._sinePinned[key] = true
                  if (sliderRefs.current[key]) sliderRefs.current[key].style.accentColor = '#cc7e2d'
                }}
                onInput={e => {
                  const v = parseFloat(e.target.value)
                  effect.values[key] = v
                  if (labelRefs.current[key]) labelRefs.current[key].textContent = v.toFixed(2)
                }}
                onPointerUp={() => onChange()} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default function Panel({
  effectsChainRef,
  videoCaptureRef,
  landmarkRef,
  // Accept both prop-name conventions (spec: videoSourceHook, legacy: videoSource)
  videoSourceHook,
  videoSource: _vsLegacy,
  frameBuffer,
  audioHook,
  fpsRef,               // optional ref to current FPS number
  faceStatusRef,        // optional ref to detection status strings
  glbUrl,
  onGlbChange,          // spec API
  setGlbUrl: _setGlbLegacy,   // legacy
  modelList,
  showStats,
  onShowStatsChange,    // spec API
  setShowStats: _setStatsLegacy,  // legacy
  showOverlay: showOverlayProp,
  onShowOverlayChange,
  isWebcamRef,
  canvasSize,
  setCanvasSize,
}) {
  // Normalise prop aliases
  const videoSource  = videoSourceHook ?? _vsLegacy
  const setGlbUrl    = onGlbChange ?? _setGlbLegacy ?? (() => {})
  const setShowStats = onShowStatsChange ?? _setStatsLegacy ?? (() => {})
  const [sectionsOpen, setSectionsOpen] = useState({ video:true, effects:true, random:true, detect:true, output:true, audio:true, more:true })
  const [, setV] = useState(0)
  const tabBodyRef    = useRef(null)
  const savedScrollRef = useRef(0)

  // Save scroll before every render triggered by bump, restore after
  const bump = useCallback(() => {
    if (tabBodyRef.current) savedScrollRef.current = tabBodyRef.current.scrollTop
    setV(v => v + 1)
  }, [])

  useLayoutEffect(() => {
    if (tabBodyRef.current && savedScrollRef.current > 0) {
      tabBodyRef.current.scrollTop = savedScrollRef.current
    }
  })
  const sectionRefs = useRef({})
  const toggleSection = useCallback((id) => {
    setSectionsOpen(s => {
      const opening = !s[id]
      if (opening) setTimeout(() => sectionRefs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 30)
      return { ...s, [id]: opening }
    })
  }, [])
  const chain = effectsChainRef.current

  const [selectedIdx, setSelectedIdx] = useState(-1)
  const [effectType,  setEffectType]  = useState(EFFECT_REGISTRY[0]?.label ?? '')

  // Sine
  const sineActiveRef = useRef(false)
  const sineSpeedRef  = useRef(0.3)
  const sineRafRef    = useRef(null)
  const smoothAnimRef = useRef(null)
  const [sineActive, setSineActive] = useState(false)
  const [sineSpeed,  setSineSpeed]  = useState(0.3)
  const [animSpeed,  setAnimSpeed]  = useState(1.0)
  // Per-slider independent sine
  const rndSineRafRef = useRef(null)
  const sineUiLastMs  = useRef(0)   // 20fps cap for UI updates

  // Detection
  const [detectConf,   setDetectConf]   = useState(0.5)
  const [preserveData, setPreserveData] = useState(false)
  const [fastMode,     setFastMode]     = useState(false)
  const [interpSmooth, setInterpSmooth] = useState(false)
  const [bgRemove,     setBgRemove]     = useState(false)
  const [globalRot,    setGlobalRot]    = useState(0)
  const [pixelTarget,  setPixelTarget]  = useState('face')
  const [fingernails,  setFingernails]  = useState(false)
  const [handFxCtrl,   setHandFxCtrl]   = useState(false)
  const [mouseFxCtrl,  setMouseFxCtrl]  = useState(false)
  const [handSens,     setHandSens]     = useState(1.5)
  const [whiteMask,    setWhiteMask]    = useState(false)
  const [whiteMaskThr, setWhiteMaskThr] = useState(185)

  // FPS / Res
  const [resScale,  setResScale]  = useState(100)
  const [inputFps,  setInputFps]  = useState(9999)
  const [outputFps, setOutputFps] = useState(9999)

  // Model status
  const [faceStatus, setFaceStatus] = useState('● Loading…')
  const [handStatus, setHandStatus] = useState('● Loading…')
  const [poseStatus, setPoseStatus] = useState('● No pose model')
  const [faceReady,  setFaceReady]  = useState(false)
  const [handReady,  setHandReady]  = useState(false)
  const [poseReady,  setPoseReady]  = useState(false)
  const detectConfTimer = useRef(null)

  // Video
  const [camRes,    setCamRes]    = useState('640x480')
  const [camActive, setCamActive] = useState(false)
  const [ytUrl,     setYtUrl]     = useState('')
  const [ytStatus,  setYtStatus]  = useState('')
  const [videoLoop, setVideoLoop] = useState(true)
  const videoFileRef = useRef(null)

  // Audio
  const [audioReact, setAudioReact] = useState(false)
  const [audioSens,  setAudioSens]  = useState(30)

  // Movie overlays
  const [ovVersion, setOvVersion] = useState(0)
  const movieFileRef = useRef(null)

  // showOverlay: controlled by prop if provided, else internal state
  const [showOverlayInternal, setShowOverlayInternal] = useState(false)
  const showOverlay = showOverlayProp !== undefined ? showOverlayProp : showOverlayInternal
  const setShowOverlay = (v) => { setShowOverlayInternal(v); onShowOverlayChange?.(v) }

  // Presets
  const [presets,    setPresets]    = useState(() => getPresets())
  const [presetName, setPresetName] = useState('')

  // ── Init globals ───────────────────────────────────────────────────────────
  useEffect(() => {
    window.OUTPUT_FPS = 9999; window.INPUT_FPS = 9999
    window.FRAME_BUF_MODE = 'idle'; window.FAST_MODE = false
    window.INTERP_SMOOTH = false; window.BG_REMOVE = false
    window.PRESERVE_DATA = false; window.PIXEL_TARGET_MODE = 'face'
    window.FINGERNAILS_MODE = false; window.HAND_FX_CONTROL = false
    window.MOUSE_FX_CONTROL = false; window.FX_OFFSET = { x: 0, y: 0 }
    window.HAND_FX_SENSITIVITY = 1.5; window.GLOBAL_ROT_SPEED = 0
    window.ANIM_SPEED = 1.0; window.AUDIO_REACT = false
    window.AUDIO_SENSITIVITY = 30; window.MIN_DETECT_CONF = 0.5
    window.RES_SCALE = 1.0; window.MOVIE_OVERLAYS = []; window._OVERLAY_SELECTED = -1
    window.WHITE_MASK_MODE = false; window.WHITE_MASK_THRESHOLD = 185
  }, [])

  // FPS counter: update from fpsRef if provided, else from DOM element updated by EffectsCanvas
  useEffect(() => {
    if (!fpsRef) return
    const id = setInterval(() => {
      const el = document.getElementById('fps-counter')
      if (el && fpsRef.current !== undefined) el.textContent = `FPS: ${Number(fpsRef.current).toFixed(1)}`
    }, 500)
    return () => clearInterval(id)
  }, [fpsRef])

  // ── Poll model status ──────────────────────────────────────────────────────
  useEffect(() => {
    const vc = videoCaptureRef?.current; if (!vc) return
    const poll = setInterval(() => {
      const st = vc.getStatus?.() ?? {}
      if (st.faceStatus !== undefined) { setFaceStatus(st.faceStatus); setFaceReady(st.faceReady ?? false) }
      if (st.handStatus !== undefined) { setHandStatus(st.handStatus); setHandReady(st.handReady ?? false) }
      if (st.poseStatus !== undefined) { setPoseStatus(st.poseStatus); setPoseReady(st.poseReady ?? false) }
    }, 800)
    return () => clearInterval(poll)
  }, [videoCaptureRef])

  const handleDetectConf = (v) => {
    setDetectConf(v); window.MIN_DETECT_CONF = v
    clearTimeout(detectConfTimer.current)
    detectConfTimer.current = setTimeout(() => {
      videoCaptureRef?.current?.reloadFace()
      videoCaptureRef?.current?.reloadHand()
    }, 600)
  }

  // ── Effects chain ──────────────────────────────────────────────────────────
  const addEffect = () => {
    const EC = EFFECT_REGISTRY.find(c => c.label === effectType); if (!EC) return
    const ef = new EC(); ef.blendMode = 'source-over'; ef.enabled = true
    chain.push(ef); setSelectedIdx(chain.length - 1); bump()
  }
  const removeEffect = (idx) => { chain.splice(idx, 1); setSelectedIdx(s => Math.min(s, chain.length - 1)); bump() }
  const dupEffect = (idx) => {
    const EC = EFFECT_REGISTRY.find(c => c.label === chain[idx].label); if (!EC) return
    const clone = new EC(); clone.values = { ...chain[idx].values }; clone.blendMode = chain[idx].blendMode ?? 'source-over'
    clone.enabled = chain[idx].enabled !== false; clone.locked = chain[idx].locked === true
    chain.splice(idx + 1, 0, clone); setSelectedIdx(idx + 1); bump()
  }
  const moveEffect = (idx, dir) => {
    const t = idx + dir; if (t < 0 || t >= chain.length) return
    ;[chain[idx], chain[t]] = [chain[t], chain[idx]]; setSelectedIdx(t); bump()
  }
  const shuffleOrder = () => {
    const fp = chain.map((e, i) => e.locked ? null : i).filter(i => i !== null)
    const fe = fp.map(i => chain[i])
    for (let i = fe.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [fe[i], fe[j]] = [fe[j], fe[i]] }
    fp.forEach((pos, k) => { chain[pos] = fe[k] }); bump()
  }
  const randomizeAll = () => { chain.forEach(randomizeEffect); bump() }
  const randomizeSel = () => { if (selectedIdx >= 0 && selectedIdx < chain.length) { randomizeEffect(chain[selectedIdx]); bump() } }

  const smoothShuffle = () => {
    const snaps = []
    for (const effect of chain) {
      if (effect.locked) continue
      for (const [key, def] of Object.entries(effect.params)) {
        if (!def || def.type === 'select' || def.type === 'text' || def.type === 'file' || def.noRandom || def.min === undefined) continue
        if (effect._sinePinned?.[key]) continue
        const from = +effect.values[key]
        let to
        if (def.rndScale !== undefined) {
          const range = (def.max - def.min) * def.rndScale
          to = Math.min(def.max, Math.max(def.min, from + (Math.random() * 2 - 1) * range))
        } else {
          to = def.min + Math.round(Math.random() * Math.round((def.max - def.min) / def.step)) * def.step
        }
        snaps.push({ effect, key, from, to })
      }
    }
    if (!snaps.length) return
    const dur = 1600; const start = performance.now()
    const frame = (now) => {
      const t = Math.min(1, (now - start) / dur)
      const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
      for (const { effect, key, from, to } of snaps) {
        const v = from + (to - from) * ease
        effect.values[key] = v
        // Write directly to DOM — zero React involvement
        if (effect._sliderEls?.[key]) effect._sliderEls[key].value = v
        if (effect._labelEls?.[key])  effect._labelEls[key].textContent = v.toFixed(2)
      }
      if (t < 1) requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  }

  // ── Keyboard shortcuts (after smoothShuffle) ───────────────────────────────
  useEffect(() => {
    const nudge = (pct) => {
      for (const ef of chain) {
        for (const [key, def] of Object.entries(ef.params)) {
          if (def.type === 'select' || def.type === 'text' || def.noRandom) continue
          const range = def.max - def.min
          ef.values[key] = Math.max(def.min, Math.min(def.max,
            parseFloat((ef.values[key] + range * pct).toFixed(6))))
        }
      }
      bump()
    }
    const nudgeSel = (pct) => {
      const ef = chain[selectedIdx]; if (!ef) return
      for (const [key, def] of Object.entries(ef.params)) {
        if (def.type === 'select' || def.type === 'text' || def.noRandom) continue
        const range = def.max - def.min
        ef.values[key] = Math.max(def.min, Math.min(def.max,
          parseFloat((ef.values[key] + range * pct).toFixed(6))))
      }
      bump()
    }
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
      const k = e.key
      if (k === ' ')  { e.preventDefault(); if (chain.length) { chain[0].enabled = !(chain[0].enabled !== false); bump() }; return }
      if (k === '1') { smoothShuffle(); return }
      if (k === '2') { nudge(-0.02); return }
      if (k === '3') { nudge(+0.02); return }
      if (k === '4') { chain.forEach(ef => { for (const [key, def] of Object.entries(ef.params)) { if (def.type === 'select' || def.type === 'text' || def.noRandom) continue; const r = def.max - def.min; ef.values[key] = Math.max(def.min, Math.min(def.max, ef.values[key] + (Math.random() - 0.5) * r * 0.1)) } }); bump(); return }
      if (k === '7') { if (chain.length > 1) { const i = Math.floor(Math.random() * chain.length); const j = (i + 1) % chain.length; [chain[i], chain[j]] = [chain[j], chain[i]]; bump() }; return }
      if (k === '9') { const ef = chain[selectedIdx]; if (ef) { const EC = EFFECT_REGISTRY.find(c => c.label === ef.label); if (EC) { const def = new EC(); ef.values = { ...def.values } }; bump() }; return }
      if (k === '0') { chain.forEach(randomizeEffect); bump(); return }
      if (k === 'q') { nudgeSel(-0.01); return }
      if (k === 'e') { nudgeSel(+0.01); return }
      if (k === 'r' || k === 'R') { chain.forEach(randomizeEffect); bump(); return }
      if (k === 'w') {
        const ef = chain[selectedIdx]; if (!ef) return
        const keys = Object.entries(ef.params).filter(([,d]) => d.type !== 'select' && d.type !== 'text' && !d.noRandom)
        const half = Math.ceil(keys.length / 2)
        keys.slice(0, half).forEach(([key, def]) => { ef.values[key] = def.min + Math.random() * (def.max - def.min) })
        bump(); return
      }
      if (k === 's' || k === 'S') { smoothShuffle(); return }
      if (k === 'a') { const EC = EFFECT_REGISTRY[Math.floor(Math.random() * EFFECT_REGISTRY.length)]; const ef = new EC(); randomizeEffect(ef); chain.push(ef); setSelectedIdx(chain.length - 1); bump(); return }
      if (k === 'd') { if (chain.length > 0) { chain.pop(); setSelectedIdx(Math.max(0, chain.length - 1)); bump() }; return }
      if (k === 'x') { if (chain.length > 0 && selectedIdx >= 0 && selectedIdx < chain.length) { chain.splice(selectedIdx, 1); setSelectedIdx(Math.max(0, selectedIdx - 1)); bump() }; return }
      if (k === 'f') { chain.reverse(); bump(); return }
      if (k === 'g') { chain.forEach(ef => { for (const [key, def] of Object.entries(ef.params)) { if (def.type === 'select' || def.type === 'text' || def.noRandom) continue; if (Math.random() < 0.5) ef.values[key] = def.min + Math.random() * (def.max - def.min) } }); bump(); return }
      if (k === 'h') { chain.forEach(ef => { for (const [key, def] of Object.entries(ef.params)) { if ((key.includes('hue') || key.includes('color')) && def.type !== 'select') ef.values[key] = Math.max(def.min, Math.min(def.max, ef.values[key] + (def.max - def.min) * 0.05)) } }); bump(); return }
      if (k === 'j') { chain.forEach(ef => { for (const [key, def] of Object.entries(ef.params)) { if (def.type === 'select' || def.type === 'text' || def.noRandom) continue; const r = def.max - def.min; ef.values[key] = Math.max(def.min, Math.min(def.max, ef.values[key] + (Math.random() - 0.5) * r * 0.04)) } }); bump(); return }
      if (k === 'k') { chain.forEach(ef => { ef.enabled = false }); bump(); return }
      if (k === 'l') { const ef = chain[selectedIdx]; if (ef) { ef.locked = !ef.locked; bump() }; return }
      if (k === 'm') { const ef = chain[selectedIdx]; if (ef) { randomizeEffect(ef); bump() }; return }
      if (k === 'b') { chain.forEach(ef => { for (const [key, def] of Object.entries(ef.params)) { if ((key.includes('blur') || key.includes('spread') || key.includes('radius')) && def.type !== 'select') ef.values[key] = Math.min(def.max, ef.values[key] + (def.max - def.min) * 0.05) } }); bump(); return }
      if (k === 'n') { chain.forEach(ef => { for (const [key, def] of Object.entries(ef.params)) { if ((key.includes('noise') || key.includes('jitter') || key.includes('glitch')) && def.type !== 'select') ef.values[key] = Math.min(def.max, ef.values[key] + (def.max - def.min) * 0.1) } }); bump(); return }
      if (k === 'p' || k === 'o') { const ef = chain[selectedIdx]; if (!ef) return; for (const [key, def] of Object.entries(ef.params)) { if (key.includes('opac') || key.includes('alpha')) ef.values[key] = Math.max(def.min, Math.min(def.max, ef.values[key] + (k === 'p' ? 0.05 : -0.05) * (def.max - def.min))) }; bump(); return }
      if (k === 'v') { chain.forEach(ef => { ef.enabled = true }); bump(); return }
      if (k === 'i') { chain.forEach(ef => { ef.enabled = !(ef.enabled !== false) }); bump(); return }
      if (k === 'c') { chain.forEach(ef => { for (const [key, def] of Object.entries(ef.params)) { if ((key.includes('color') || key.includes('hue') || key.includes('tint')) && def.type !== 'select') ef.values[key] = def.max - (ef.values[key] - def.min) } }); bump(); return }
      if (k === 'z') { const ef = chain[selectedIdx]; if (!ef) return; const EC = EFFECT_REGISTRY.find(c => c.label === ef.label); if (!EC) return; const def2 = new EC(); ef.values = { ...def2.values }; bump(); return }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [chain, bump, selectedIdx, smoothShuffle, randomizeEffect, setSelectedIdx])

  const toggleSine = () => {
    if (sineActiveRef.current) {
      sineActiveRef.current = false; setSineActive(false)
      if (sineRafRef.current) { cancelAnimationFrame(sineRafRef.current); sineRafRef.current = null }
    } else {
      sineActiveRef.current = true; setSineActive(true)
      const loop = () => {
        if (!sineActiveRef.current) { sineRafRef.current = null; return }
        const t = performance.now() / 1000
        for (const effect of chain) {
          for (const [key, def] of Object.entries(effect.params)) {
            if (effect._sinePinned?.[key] || effect._rndSine?.[key]) continue
            if (def.type === 'select' || def.type === 'text' || def.noRandom) continue
            if (!effect._sinePhases) effect._sinePhases = {}
            if (effect._sinePhases[key] === undefined) effect._sinePhases[key] = Math.random() * Math.PI * 2
            const norm = (Math.sin(t * sineSpeedRef.current + effect._sinePhases[key]) + 1) / 2
            const v = parseFloat((def.min + Math.round(norm * Math.round((def.max - def.min) / def.step)) * def.step).toFixed(6))
            effect.values[key] = v
          }
        }
        // 20fps cap for DOM writes
        const now = performance.now()
        if (now - sineUiLastMs.current >= 50) {
          sineUiLastMs.current = now
          for (const effect of chain) {
            for (const [key] of Object.entries(effect.params)) {
              if (effect._sliderEls?.[key]) effect._sliderEls[key].value = effect.values[key]
              if (effect._labelEls?.[key])  effect._labelEls[key].textContent = parseFloat(effect.values[key]).toFixed(2)
            }
          }
        }
        sineRafRef.current = requestAnimationFrame(loop)
      }
      sineRafRef.current = requestAnimationFrame(loop)
    }
  }

  // Per-slider independent sine loop
  const startRndSineLoop = useCallback(() => {
    if (rndSineRafRef.current !== null) return
    const loop = () => {
      const t = performance.now() / 1000
      let anyActive = false
      for (const effect of chain) {
        if (!effect._rndSine) continue
        for (const [key, on] of Object.entries(effect._rndSine)) {
          if (!on) continue
          anyActive = true
          const def = effect.params[key]
          if (!def || def.type === 'select' || def.type === 'text' || def.noRandom) continue
          const freq  = effect._rndSineFreq?.[key]  ?? 1
          const phase = effect._rndSinePhase?.[key] ?? 0
          const norm  = (Math.sin(t * sineSpeedRef.current * freq + phase) + 1) / 2
          const steps = Math.round((def.max - def.min) / def.step)
          const v = parseFloat((def.min + Math.round(norm * steps) * def.step).toFixed(6))
          effect.values[key] = v
        }
      }
      // 20fps cap for DOM writes
      const now = performance.now()
      if (now - sineUiLastMs.current >= 50) {
        sineUiLastMs.current = now
        for (const effect of chain) {
          if (!effect._rndSine) continue
          for (const [key, on] of Object.entries(effect._rndSine)) {
            if (!on) continue
            if (effect._sliderEls?.[key]) effect._sliderEls[key].value = effect.values[key]
            if (effect._labelEls?.[key])  effect._labelEls[key].textContent = parseFloat(effect.values[key]).toFixed(2)
          }
        }
      }
      if (anyActive) {
        rndSineRafRef.current = requestAnimationFrame(loop)
      } else {
        rndSineRafRef.current = null
      }
    }
    rndSineRafRef.current = requestAnimationFrame(loop)
  }, [chain])

  // ── Drag reorder ───────────────────────────────────────────────────────────
  const dragSrcRef = useRef(-1)
  const dragGhRef  = useRef(null)
  const dragOffY   = useRef(0)

  const startDrag = (idx, liEl, e) => {
    e.preventDefault(); dragSrcRef.current = idx
    const rect = liEl.getBoundingClientRect(); dragOffY.current = e.clientY - rect.top
    const ghost = liEl.cloneNode(true)
    Object.assign(ghost.style, {
      position: 'fixed', left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px',
      opacity: '0.85', pointerEvents: 'none', zIndex: '9999', background: '#1c1c1c',
      border: '1px dashed #2d7a50', borderRadius: '3px', boxShadow: '0 6px 18px rgba(0,0,0,0.6)',
    })
    document.body.appendChild(ghost); dragGhRef.current = ghost; liEl.style.opacity = '0.25'
    const onMove = (ev) => { if (dragGhRef.current) dragGhRef.current.style.top = (ev.clientY - dragOffY.current) + 'px' }
    const onUp = (ev) => {
      window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp)
      if (dragGhRef.current) { dragGhRef.current.remove(); dragGhRef.current = null }
      liEl.style.opacity = ''
      const list = document.getElementById('effects-list'); if (!list) { dragSrcRef.current = -1; return }
      const items = Array.from(list.querySelectorAll('.fx-item'))
      let dropIdx = -1
      for (const item of items) { const r = item.getBoundingClientRect(); if (ev.clientY >= r.top && ev.clientY <= r.bottom) { dropIdx = parseInt(item.dataset.idx); break } }
      const src = dragSrcRef.current; dragSrcRef.current = -1
      if (dropIdx >= 0 && dropIdx !== src) {
        const [moved] = chain.splice(src, 1); chain.splice(dropIdx, 0, moved)
        setSelectedIdx(prev => {
          if (prev === src) return dropIdx
          if (src < dropIdx && prev > src && prev <= dropIdx) return prev - 1
          if (src > dropIdx && prev < src && prev >= dropIdx) return prev + 1
          return prev
        }); bump()
      }
    }
    window.addEventListener('pointermove', onMove, { passive: true }); window.addEventListener('pointerup', onUp)
  }

  // ── Video ──────────────────────────────────────────────────────────────────
  const handleWebcam = async () => {
    if (camActive) { videoSource?.stopWebcam?.(); setCamActive(false) }
    else { try { await videoSource?.startWebcam?.(camRes); setCamActive(true) } catch (err) { console.error(err) } }
  }
  // Auto-restart webcam with new resolution when already active
  const handleCamRes = async (res) => {
    setCamRes(res)
    if (camActive) {
      try { await videoSource?.startWebcam?.(res) } catch (err) { console.error(err) }
    }
  }
  const handleVideoFile = (e) => { const f = e.target.files?.[0]; if (f) videoSource?.loadVideoFile?.(f); e.target.value = '' }
  const handleYt = async () => {
    if (!ytUrl.trim()) return; setYtStatus('● Fetching…')
    try { await videoSource?.loadYouTube?.(ytUrl); setYtStatus('● Playing') }
    catch (err) { setYtStatus(`● Error: ${err.message}`) }
  }

  // ── Movie overlays ─────────────────────────────────────────────────────────
  const addMovieFile = (e) => {
    const files = e.target.files; if (!files?.length) return
    const ovs = window.MOVIE_OVERLAYS ?? []
    for (const file of Array.from(files)) {
      if (ovs.length >= 5) break
      const el = document.createElement('video')
      el.src = URL.createObjectURL(file); el.loop = true; el.muted = true; el.playsInline = true
      const ov = { el, name: file.name, x: 20 + ovs.length * 22, y: 20 + ovs.length * 22, w: 320, h: 180, opacity: 1, visible: true }
      ovs.push(ov)
      el.addEventListener('loadeddata', () => { if (el.videoWidth) ov.h = Math.round(320 * el.videoHeight / el.videoWidth); setOvVersion(v => v + 1) }, { once: true })
      el.play().catch(() => {})
    }
    setOvVersion(v => v + 1); e.target.value = ''
  }

  // ── Presets ────────────────────────────────────────────────────────────────
  const savePreset = () => {
    const name = presetName.trim() || `Preset ${getPresets().length + 1}`
    const all = getPresets(); const existing = all.findIndex(p => p.name === name)
    const preset = {
      name, ts: Date.now(),
      effects: chain.map(e => ({
        label: e.label, values: { ...e.values },
        blendMode: e.blendMode ?? 'source-over',
        enabled: e.enabled !== false,
        locked: e.locked === true,
        sinePinned: { ...(e._sinePinned ?? {}) },
        rndSine:      { ...(e._rndSine      ?? {}) },
        rndSinePhase: { ...(e._rndSinePhase ?? {}) },
        rndSineFreq:  { ...(e._rndSineFreq  ?? {}) },
      })),
      globalSettings: {
        // Detection / render
        pixelTargetMode: window.PIXEL_TARGET_MODE ?? 'face',
        bgRemove:        window.BG_REMOVE ?? false,
        interpSmooth:    window.INTERP_SMOOTH ?? false,
        preserveData:    window.PRESERVE_DATA ?? false,
        fastMode:        window.FAST_MODE ?? false,
        // FX control
        globalRotSpeed:  window.GLOBAL_ROT_SPEED ?? 0,
        fingernails:     window.FINGERNAILS_MODE ?? false,
        handFxCtrl:      window.HAND_FX_CONTROL ?? false,
        mouseFxCtrl:     window.MOUSE_FX_CONTROL ?? false,
        handSens:        window.HAND_FX_SENSITIVITY ?? 1.5,
        // FPS / res
        resScale:        resScale,
        inputFps:        window.INPUT_FPS ?? 60,
        outputFps:       window.OUTPUT_FPS ?? 60,
        // Audio
        audioReact:      window.AUDIO_REACT ?? false,
        audioSens:       window.AUDIO_SENSITIVITY ?? 30,
        // Animation
        animSpeed:       window.ANIM_SPEED ?? 1.0,
        sineSpeed:       sineSpeedRef.current,
        sineActive:      sineActiveRef.current,
        // Detection confidence
        detectConf:      window.MIN_DETECT_CONF ?? 0.5,
      },
    }
    if (existing >= 0) all[existing] = preset; else all.unshift(preset)
    savePresets(all); setPresets(getPresets()); setPresetName('')
  }

  const loadPreset = (preset) => {
    chain.length = 0
    for (const saved of preset.effects) {
      const EC = EFFECT_REGISTRY.find(c => c.label === saved.label); if (!EC) continue
      const ef = new EC()
      ef.values = { ...ef.values, ...saved.values }
      ef.blendMode = saved.blendMode ?? 'source-over'
      ef.enabled   = saved.enabled !== false
      ef.locked    = saved.locked === true
      ef._sinePinned  = { ...(saved.sinePinned  ?? {}) }
      ef._rndSine     = { ...(saved.rndSine     ?? {}) }
      ef._rndSinePhase= { ...(saved.rndSinePhase?? {}) }
      ef._rndSineFreq = { ...(saved.rndSineFreq ?? {}) }
      chain.push(ef)
    }
    setSelectedIdx(chain.length > 0 ? 0 : -1)

    const gs = preset.globalSettings ?? {}
    const set = (key, setter, winKey, val) => {
      if (val === undefined) return
      if (winKey) window[winKey] = val
      setter(val)
    }

    set('pixelTargetMode', setPixelTarget,   'PIXEL_TARGET_MODE', gs.pixelTargetMode)
    set('bgRemove',        setBgRemove,       'BG_REMOVE',         gs.bgRemove)
    set('interpSmooth',    setInterpSmooth,   'INTERP_SMOOTH',     gs.interpSmooth)
    set('preserveData',    setPreserveData,   'PRESERVE_DATA',     gs.preserveData)
    set('fastMode',        setFastMode,       'FAST_MODE',         gs.fastMode)
    set('globalRot',       setGlobalRot,      'GLOBAL_ROT_SPEED',  gs.globalRotSpeed)
    set('fingernails',     setFingernails,    'FINGERNAILS_MODE',  gs.fingernails)
    set('handFxCtrl',      setHandFxCtrl,     'HAND_FX_CONTROL',   gs.handFxCtrl)
    set('mouseFxCtrl',     setMouseFxCtrl,    'MOUSE_FX_CONTROL',  gs.mouseFxCtrl)
    set('handSens',        setHandSens,       'HAND_FX_SENSITIVITY', gs.handSens)
    set('inputFps',        setInputFps,       'INPUT_FPS',         gs.inputFps)
    set('outputFps',       setOutputFps,      'OUTPUT_FPS',        gs.outputFps)
    set('audioSens',       setAudioSens,      'AUDIO_SENSITIVITY', gs.audioSens)
    set('animSpeed',       setAnimSpeed,      'ANIM_SPEED',        gs.animSpeed)
    set('detectConf',      setDetectConf,     'MIN_DETECT_CONF',   gs.detectConf)

    if (gs.resScale !== undefined) { window.RES_SCALE = gs.resScale / 100; setResScale(gs.resScale) }
    if (gs.audioReact !== undefined) { window.AUDIO_REACT = gs.audioReact; setAudioReact(gs.audioReact) }
    if (gs.sineSpeed  !== undefined) { sineSpeedRef.current = gs.sineSpeed; setSineSpeed(gs.sineSpeed) }

    // Restore sine state
    if (gs.sineActive !== undefined && gs.sineActive !== sineActiveRef.current) toggleSine()

    bump()
  }

  const deletePreset = (idx) => { const all = getPresets(); all.splice(idx, 1); savePresets(all); setPresets(getPresets()) }

  const fpsLabel = (v) => v >= 9999 ? '∞' : v % 1 === 0 ? String(v) : v.toFixed(1)
  const rotLabel = (v) => v === 0 ? 'off' : (v > 0 ? '+' : '') + v.toFixed(2) + 'x'
  const selEffect = selectedIdx >= 0 && selectedIdx < chain.length ? chain[selectedIdx] : null
  const CAT_COLORS = { DRAW: '#1a3a2a', PIXEL: '#1a2a3a', BLEND: '#2a1a3a', FULL: '#3a2a1a', LAYER: '#3a3a1a', OVERLAY: '#1a3a3a', FACE: '#2a1a1a' }

  // ── SECTION CONTENT ────────────────────────────────────────────────────────
  const renderSectionContent = (id) => {
    switch (id) {

    case 'video': return (
      <>
        <div className="field-group">
          <label className="field-label">Webcam</label>
          <div className="row2">
            <select value={camRes} onChange={e => handleCamRes(e.target.value)}>
              {['320x240','640x480','1280x720','1920x1080'].map(r => <option key={r}>{r}</option>)}
            </select>
            <button onClick={handleWebcam} className={camActive ? 'primary' : ''}>{camActive ? '⏹ Stop' : '📷 Start'}</button>
          </div>
        </div>
        <div className="field-group">
          <label className="field-label">Canvas Display Size {canvasSize}%</label>
          <div className="row2">
            <input type="range" min="10" max="100" step="1" value={canvasSize} style={{ flex: 1 }}
              onChange={e => setCanvasSize(parseInt(e.target.value))} />
            <button onClick={() => setCanvasSize(100)} style={{ fontSize: 10, padding: '2px 6px' }}>↺</button>
          </div>
        </div>
        <div className="field-group">
          <label className="field-label">Other Sources</label>
          <button onClick={() => videoSource?.startScreenCapture?.()}>🖥 Screen Capture</button>
          <button onClick={() => videoFileRef.current?.click()}>📂 Load Video File…</button>
          <input ref={videoFileRef} type="file" accept="video/*" style={{ display: 'none' }} onChange={handleVideoFile} />
        </div>
        <div className="field-group">
          <label className="field-label">YouTube</label>
          <div className="row2">
            <input value={ytUrl} onChange={e => setYtUrl(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleYt()} placeholder="Paste URL…" style={{ flex: 1 }} />
            <button onClick={handleYt}>▶</button>
          </div>
          {ytStatus && <div className="hint">{ytStatus}</div>}
        </div>
        <div className="field-group">
          <label className="field-label">Playback</label>
          <div className="row3">
            <button onClick={videoSource?.play}>▶</button>
            <button onClick={videoSource?.pause}>⏸</button>
            <button onClick={() => { videoSource?.toggleLoop?.(); setVideoLoop(l => !l) }}>🔁 {videoLoop ? 'ON' : 'OFF'}</button>
          </div>
        </div>
        <div className="status-row">
          <span className={`dot ${camActive ? 'ready' : ''}`} />
          <span>{videoSource?.label ?? 'No source'}</span>
        </div>
        <div id="fps-counter" className="hint" style={{ textAlign: 'right' }}>FPS: –</div>
      </>
    )

    case 'effects': return (
      <>
        <div className="row2">
          <select value={effectType} onChange={e => setEffectType(e.target.value)} style={{ flex: 1, fontSize: 10 }}>
            {EFFECT_REGISTRY.map(EC => <option key={EC.label} value={EC.label}>{EC.label}</option>)}
          </select>
          <button onClick={addEffect} className="primary">+ Add</button>
        </div>
        <ul id="effects-list" className="fx-list">
          {chain.length === 0 && <li style={{ fontSize: 11, color: '#333', padding: '4px 2px' }}>No effects yet.</li>}
          {chain.map((effect, idx) => [
            idx > 0 && (
              <li key={`b${idx}`} className="blend-connector">
                <select value={effect.blendMode ?? 'source-over'}
                  onChange={e => { chain[idx].blendMode = e.target.value; bump() }}>
                  {BLEND_MODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </li>
            ),
            <li key={idx} className={`fx-item${idx === selectedIdx ? ' selected' : ''}${effect.enabled === false ? ' disabled' : ''}${effect.locked ? ' locked' : ''}`}
              data-idx={idx}
              onClick={(e) => { if (!e.target.dataset.action) setSelectedIdx(idx) }}>
              <span className="drag-handle" onPointerDown={e => startDrag(idx, e.currentTarget.closest('li'), e)}>⠿</span>
              <div className="fx-info">
                <div className="fx-name">{effect.label}</div>
                <span className="badge" style={{ background: CAT_COLORS[effect.category] ?? '#222' }}>{effect.category}</span>
              </div>
              <div className="fx-btns">
                <button data-action="up"   onClick={e => { e.stopPropagation(); moveEffect(idx,-1) }}>▲</button>
                <button data-action="down" onClick={e => { e.stopPropagation(); moveEffect(idx,+1) }}>▼</button>
                <button data-action="lock" className={effect.locked ? 'primary' : ''}
                  onClick={e => { e.stopPropagation(); chain[idx].locked = !chain[idx].locked; bump() }}>🔒</button>
                <button data-action="toggle" className={effect.enabled !== false ? 'primary' : ''}
                  onClick={e => { e.stopPropagation(); chain[idx].enabled = !(chain[idx].enabled !== false); bump() }}>
                  {effect.enabled !== false ? '●' : '○'}</button>
                <button data-action="dup" onClick={e => { e.stopPropagation(); dupEffect(idx) }}>⧉</button>
                <button data-action="del" className="danger" onClick={e => { e.stopPropagation(); removeEffect(idx) }}>✕</button>
              </div>
            </li>,
          ])}
        </ul>
        <div className="params-panel" style={{ flexShrink: 0, overflowY: 'auto', maxHeight: '50%' }}>
          {!selEffect && <div className="hint" style={{ padding: 4 }}>Select effect to edit params.</div>}
          {selEffect && (
            <div>
              <div style={{ fontSize: 11, color: '#888', marginBottom: 5 }}>
                {selEffect.label}
                <span className="badge" style={{ marginLeft: 5, background: CAT_COLORS[selEffect.category] ?? '#222' }}>{selEffect.category}</span>
              </div>
              <ParamsEditor effect={selEffect} onChange={bump} onRndSineChanged={startRndSineLoop} />
            </div>
          )}
        </div>
      </>
    )

    case 'random': return (
      <>
        <div className="field-group">
          <label className="field-label">Randomize</label>
          <div className="row2">
            <button onClick={shuffleOrder}>🔀 Shuffle</button>
            <button onClick={randomizeSel}>🎲 Selected</button>
          </div>
          <div className="row2">
            <button onClick={randomizeAll}>🎲 All</button>
            <button onClick={smoothShuffle}>🌀 Smooth</button>
          </div>
        </div>
        <div className="field-group">
          <label className="field-label">Sine Wave Oscillation</label>
          <button onClick={toggleSine} className={sineActive ? 'primary' : ''} style={{ width: '100%' }}>
            🌊 Sine: {sineActive ? '● ON' : 'OFF'}
          </button>
          <div>
            <label className="field-label">Speed {sineSpeed.toFixed(2)}</label>
            <input type="range" min="0.01" max="5" step="0.01" value={sineSpeed}
              onChange={e => { const v = parseFloat(e.target.value); sineSpeedRef.current = v; setSineSpeed(v) }} />
          </div>
        </div>
        <div className="field-group">
          <label className="field-label">Animation Speed {animSpeed.toFixed(2)}x</label>
          <input type="range" min="0.1" max="3" step="0.05" value={animSpeed}
            onChange={e => { const v = parseFloat(e.target.value); window.ANIM_SPEED = v; setAnimSpeed(v) }} />
        </div>
        <div className="hint">Shortcuts: R = rnd all &nbsp;·&nbsp; S = smooth &nbsp;·&nbsp; 1–9 = toggle fx</div>
      </>
    )

    case 'detect': return (
      <>
        <div className="field-group">
          <label className="field-label">MediaPipe Models</label>
          <ModelRow label="Face" status={faceStatus} ready={faceReady} onLoad={async (buf, name) => videoCaptureRef?.current?.reloadFace(buf, name)} />
          <ModelRow label="Hand" status={handStatus} ready={handReady} onLoad={async (buf, name) => videoCaptureRef?.current?.reloadHand(buf, name)} />
          <ModelRow label="Pose" status={poseStatus} ready={poseReady} onLoad={async (buf, name) => videoCaptureRef?.current?.reloadPose(buf, name)} />
          <div>
            <label className="field-label">Detection Confidence {detectConf.toFixed(2)}</label>
            <input type="range" min="0.1" max="1" step="0.01" value={detectConf} onChange={e => handleDetectConf(parseFloat(e.target.value))} />
          </div>
        </div>
        <div className="field-group">
          <label className="field-label">Landmark Options</label>
          <Check label="Preserve Data (anti-flicker)" checked={preserveData} onChange={v => { window.PRESERVE_DATA = v; setPreserveData(v) }} />
          <Check label="Fast Mode (skip alt frames)"  checked={fastMode}     onChange={v => { window.FAST_MODE = v; setFastMode(v) }} />
          <Check label="Frame Interpolation"          checked={interpSmooth} onChange={v => { window.INTERP_SMOOTH = v; setInterpSmooth(v) }} />
          <Check label="BG Remove (face oval clip)"   checked={bgRemove}     onChange={v => { window.BG_REMOVE = v; setBgRemove(v) }} />
          <Check label="White Mask Mode"              checked={whiteMask}    onChange={v => { window.WHITE_MASK_MODE = v; setWhiteMask(v) }} />
          {whiteMask && (
            <div className="param-row">
              <div className="param-label"><span>Mask Threshold</span><span>{whiteMaskThr}</span></div>
              <input type="range" min={50} max={255} step={1} value={whiteMaskThr}
                onChange={e => { const v = parseInt(e.target.value); window.WHITE_MASK_THRESHOLD = v; setWhiteMaskThr(v) }} />
            </div>
          )}
        </div>
        <div className="field-group">
          <label className="field-label">FX Control</label>
          <div>
            <label className="field-label">Pixel Target</label>
            <select value={pixelTarget} onChange={e => { window.PIXEL_TARGET_MODE = e.target.value; setPixelTarget(e.target.value) }}>
              <option value="face">Face Region</option>
              <option value="screen">Full Screen</option>
              <option value="face-mask">Face Mask (clip)</option>
            </select>
          </div>
          <Check label="Fingernails Mode"      checked={fingernails}  onChange={v => { window.FINGERNAILS_MODE = v; setFingernails(v) }} />
          <Check label="Mouse FX Control"      checked={mouseFxCtrl} onChange={v => { window.MOUSE_FX_CONTROL = v; setMouseFxCtrl(v); if (!v) window.FX_OFFSET = { x:0, y:0 } }} />
          <Check label="Hand FX Control"       checked={handFxCtrl}  onChange={v => { window.HAND_FX_CONTROL = v; setHandFxCtrl(v) }} />
          {handFxCtrl && (
            <div>
              <label className="field-label">Sensitivity {handSens.toFixed(1)}</label>
              <input type="range" min="0.1" max="5" step="0.1" value={handSens}
                onChange={e => { const v = parseFloat(e.target.value); window.HAND_FX_SENSITIVITY = v; setHandSens(v) }} />
            </div>
          )}
          <div>
            <label className="field-label">Global 3D Rotation {rotLabel(globalRot)}</label>
            <div className="row2">
              <input type="range" min="-1" max="1" step="0.01" value={globalRot} style={{ flex: 1 }}
                onChange={e => { const v = parseFloat(e.target.value); window.GLOBAL_ROT_SPEED = v; setGlobalRot(v) }} />
              <button onClick={() => { window.GLOBAL_ROT_SPEED = 0; setGlobalRot(0) }}>↺</button>
            </div>
          </div>
        </div>
      </>
    )

    case 'output': return (
      <>
        <div className="field-group">
          <label className="field-label">Resolution Scale {resScale}%</label>
          <input type="range" min="10" max="100" step="5" value={resScale}
            onChange={e => { const v = parseInt(e.target.value); window.RES_SCALE = v / 100; setResScale(v) }} />
        </div>
        <div className="field-group">
          <label className="field-label">Input FPS {fpsLabel(inputFps)}</label>
          <input type="range" min="1" max="9999" step="1" value={inputFps}
            onChange={e => { const v = parseFloat(e.target.value); window.INPUT_FPS = v; setInputFps(v) }} />
          <label className="field-label">Output FPS {fpsLabel(outputFps)}</label>
          <input type="range" min="1" max="9999" step="1" value={outputFps}
            onChange={e => { const v = parseFloat(e.target.value); window.OUTPUT_FPS = v; setOutputFps(v) }} />
        </div>
        <div className="field-group">
          <label className="field-label">Outputs</label>
          <div className="row3">
            <button onClick={() => window.toggleSpoutOut?.()}
              title="Send canvas via Spout (requires native integration)">📡 Spout Out</button>
            <button onClick={() => window.toggleProjectorView?.()}
              title="Open projector/second-window output">🪟 Projector</button>
          </div>
        </div>
        <div className="field-group">
          <label className="field-label">Frame Buffer</label>
          <div>
            <label className="field-label">Buffer Size {frameBuffer?.bufSize ?? 30} frames</label>
            <input type="range" min="2" max="240" step="1" value={frameBuffer?.bufSize ?? 30}
              onChange={e => frameBuffer?.setBufSize?.(parseInt(e.target.value))} />
          </div>
          <div className="row3">
            <button onClick={frameBuffer?.record} className={frameBuffer?.mode === 'recording' ? 'primary' : ''} disabled={frameBuffer?.mode === 'recording'}>⏺ Rec</button>
            <button onClick={frameBuffer?.play}   className={frameBuffer?.mode === 'playing'   ? 'primary' : ''} disabled={frameBuffer?.mode === 'playing' || (frameBuffer?.count?.() ?? 0) === 0}>▶ Play</button>
            <button onClick={frameBuffer?.stop}   disabled={frameBuffer?.mode === 'idle'}>⏹ Stop</button>
          </div>
          <div id="frame-buf-status" className="hint"
            style={{ color: frameBuffer?.mode === 'recording' ? '#c97e7e' : frameBuffer?.mode === 'playing' ? '#7ecc94' : '#444' }}>
            {frameBuffer?.mode === 'idle' ? '● Idle' : frameBuffer?.mode === 'recording' ? `● Recording…` : `▶ Looping ${frameBuffer?.count?.() ?? 0}f`}
          </div>
        </div>
      </>
    )

    case 'audio': return (
      <>
        <Check label="Enable Audio Reactivity" checked={audioReact}
          onChange={async v => { window.AUDIO_REACT = v; setAudioReact(v); if (v && !audioHook?.isActive) await audioHook?.init?.() }} />
        {audioReact && (
          <>
            <div className="field-group">
              <label className="field-label">Sensitivity {audioSens}</label>
              <input type="range" min="1" max="128" step="1" value={audioSens}
                onChange={e => { const v = parseInt(e.target.value); window.AUDIO_SENSITIVITY = v; setAudioSens(v) }} />
            </div>
            <div className="audio-level-wrap">
              <div id="audio-level-bar" className="audio-level-bar"
                style={{ width: `${((audioHook?.audioLevel ?? audioHook?.level ?? 0) * 100).toFixed(1)}%` }} />
            </div>
            <div className="hint">On beat: nudges params of all enabled effects.</div>
          </>
        )}
        {!audioReact && <div className="hint">Enable to react to mic input.</div>}
      </>
    )

    case 'more': return (
      <>
        <div className="field-group">
          <label className="field-label">3D Model (GLB)</label>
          <select value={glbUrl ?? ''} onChange={e => setGlbUrl(e.target.value || null)}>
            <option value=''>— None —</option>
            {(modelList ?? []).map(u => <option key={u} value={u}>{u.split('/').pop()}</option>)}
          </select>
          <label className="btn-file">Load local GLB…
            <input type="file" accept=".glb,.gltf" style={{ display: 'none' }}
              onChange={e => { const f = e.target.files?.[0]; if (f) setGlbUrl(URL.createObjectURL(f)) }} />
          </label>
          <Check label="Show Stats" checked={showStats} onChange={setShowStats} />
          <Check label="Face Overlay" checked={showOverlay} onChange={setShowOverlay} />
        </div>

        <div className="field-group">
          <label className="field-label">Movie Overlays (max 5)</label>
          <button onClick={() => movieFileRef.current?.click()}>📽 Add Video…</button>
          <input ref={movieFileRef} type="file" accept="video/*" multiple style={{ display: 'none' }} onChange={addMovieFile} />
          {(window.MOVIE_OVERLAYS ?? []).map((ov, i) => (
            <div key={i} className="ov-row">
              <span className={`dot ${ov.visible ? 'ready' : ''}`} />
              <span style={{ flex: 1, fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ov.name}</span>
              <button onClick={() => { ov.visible = !ov.visible; setOvVersion(v => v + 1) }}>{ov.visible ? '●' : '○'}</button>
              <input type="range" min="0" max="1" step="0.01" value={ov.opacity} style={{ width: 50 }}
                onChange={e => { ov.opacity = parseFloat(e.target.value); setOvVersion(v => v + 1) }} />
              <button className="danger" onClick={() => { window.MOVIE_OVERLAYS.splice(i, 1); setOvVersion(v => v + 1) }}>✕</button>
            </div>
          ))}
        </div>

        <div className="field-group">
          <label className="field-label">Presets</label>
          <div className="row2">
            <input value={presetName} onChange={e => setPresetName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && savePreset()}
              placeholder="Preset name…" style={{ flex: 1 }} />
            <button onClick={savePreset} className="primary">💾</button>
          </div>
          <div className="preset-list">
            {presets.map((p, i) => (
              <div key={i} className="preset-row">
                <span style={{ flex: 1, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                <button onClick={() => loadPreset(p)}>Load</button>
                <button className="danger" onClick={() => deletePreset(i)}>✕</button>
              </div>
            ))}
            {presets.length === 0 && <div className="hint">No presets saved yet.</div>}
          </div>
        </div>
      </>
    )

    default: return null
    }
  }

  return (
    <div className="panel-inner">
      {/* 2-column layout — left: controls, right: effects+params */}
      <div className="two-col">
        {/* ── LEFT COLUMN: all control sections ── */}
        <div className="col-left">
          {['video','detect','output','audio','random','more'].map(id => {
            const t = TABS.find(x => x.id === id); if (!t) return null
            return (
              <div key={id} ref={el => { sectionRefs.current[id] = el }} className="psec">
                <button className="psec-hdr" onClick={() => toggleSection(id)}>
                  <span className="tab-icon" style={{ fontSize: 11 }}>{t.icon}</span>
                  <span style={{ flex: 1 }}>{t.label}</span>
                  <span style={{ fontSize: 9, opacity: 0.4 }}>{sectionsOpen[id] ? '▾' : '▸'}</span>
                </button>
                {sectionsOpen[id] && (
                  <div className="psec-body">{renderSectionContent(id)}</div>
                )}
              </div>
            )
          })}
        </div>

        {/* ── RIGHT COLUMN: effects list + params editor ── */}
        <div className="col-right">
          <div className="psec" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <div className="psec-hdr" style={{ cursor: 'default' }}>
              <span className="tab-icon" style={{ fontSize: 11 }}>✦</span>
              <span style={{ flex: 1 }}>Effects</span>
            </div>
            <div className="psec-body" style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {renderSectionContent('effects')}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
