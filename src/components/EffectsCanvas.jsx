// EffectsCanvas.jsx — Full 2D draw loop: video → effects chain → overlays → frame buffer.
import { useRef, useEffect, forwardRef, useImperativeHandle } from 'react'
import { makeP } from '../lib/p5compat'

function _rotateOneY(lms, angle) {
  if (!lms?.length) return lms
  let cx = 0, cz = 0
  for (const lm of lms) { cx += lm.x; cz += (lm.z ?? 0) }
  cx /= lms.length; cz /= lms.length
  const c = Math.cos(angle), s = Math.sin(angle), ZS = 1.5
  return lms.map(lm => ({ ...lm, x: cx + (lm.x - cx) * c + ((lm.z ?? 0) - cz) * ZS * s }))
}
function _rotateGroupY(groups, angle) {
  if (!groups?.length || !angle) return groups
  return groups.map(lms => _rotateOneY(lms, angle))
}
function _faceArea(lms) {
  if (!lms?.length) return 0
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const lm of lms) {
    if (lm.x < minX) minX = lm.x; if (lm.x > maxX) maxX = lm.x
    if (lm.y < minY) minY = lm.y; if (lm.y > maxY) maxY = lm.y
  }
  return (maxX - minX) * (maxY - minY)
}

const EffectsCanvas = forwardRef(function EffectsCanvas(
  { videoRef, landmarkRef, effectsChainRef, audioHook, frameBuffer, isWebcamRef: isWebcamProp,
    width: propW, height: propH, style },
  ref
) {
  const canvasRef = useRef(null)
  const rafRef    = useRef(null)
  const globalRotAngle = useRef(0)
  const lastOutputMs   = useRef(0)
  const lastInputMs    = useRef(0)
  const lastVideoTime  = useRef(-1)
  const fpsCount       = useRef(0)
  const fpsLastMs      = useRef(0)
  const outputCache    = useRef(null)
  const inputCache     = useRef(null)
  const bgOffCanvas    = useRef(null)
  const bgLastFrame    = useRef(null)
  const bgLastFaceMs   = useRef(0)
  const interpPrev     = useRef(null)
  const interpCurr     = useRef(null)
  const interpLastMs   = useRef(0)
  const interpInterval = useRef(33)
  const interpPrevTime = useRef(-1)
  const snapBefore     = useRef(null)
  const snapAfter      = useRef(null)
  const baseFrame      = useRef(null)
  const lastFaceRes    = useRef(null)
  const lastHandRes    = useRef(null)
  const lastPoseRes    = useRef(null)
  const frameCount     = useRef(0)   // for fast-mode frame skipping

  useImperativeHandle(ref, () => ({ canvas: () => canvasRef.current }))

  // Initialize window globals on mount
  useEffect(() => {
    window._frameBuf        = window._frameBuf        ?? []
    window.MOVIE_OVERLAYS   = window.MOVIE_OVERLAYS   ?? []
    window._OVERLAY_SELECTED = window._OVERLAY_SELECTED ?? -1
    window.FRAME_BUF_SIZE   = window.FRAME_BUF_SIZE   ?? 30
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    function draw() {
      rafRef.current = requestAnimationFrame(draw)
      const nowMs = performance.now()

      // FPS
      fpsCount.current++
      if (nowMs - fpsLastMs.current >= 500) {
        const fps = fpsCount.current * 1000 / (nowMs - fpsLastMs.current)
        fpsCount.current = 0; fpsLastMs.current = nowMs
        const el = document.getElementById('fps-counter')
        if (el) el.textContent = `FPS: ${fps.toFixed(1)}`
      }

      const outFps = window.OUTPUT_FPS ?? 9999
      // 0 = unlimited (run every RAF frame)
      const outLimited = outFps > 0 && outFps < 9999
      const ctx    = canvas.getContext('2d')

      // Frame buffer playback
      if (window.FRAME_BUF_MODE === 'playing' && frameBuffer?.framesRef.current.length > 0) {
        if (outLimited && nowMs - lastOutputMs.current < 1000 / outFps) {
          if (outputCache.current) ctx.drawImage(outputCache.current, 0, 0)
          return
        }
        lastOutputMs.current = nowMs
        const bf = frameBuffer.nextFrame()
        if (bf) {
          if (canvas.width !== bf.width || canvas.height !== bf.height) { canvas.width = bf.width; canvas.height = bf.height }
          ctx.drawImage(bf, 0, 0)
          if (!outputCache.current || outputCache.current.width !== canvas.width) {
            outputCache.current = document.createElement('canvas')
            outputCache.current.width = canvas.width; outputCache.current.height = canvas.height
          }
          outputCache.current.getContext('2d').drawImage(bf, 0, 0)
        }
        return
      }

      // Output FPS limiter
      if (outLimited && nowMs - lastOutputMs.current < 1000 / outFps) {
        if (outputCache.current) ctx.drawImage(outputCache.current, 0, 0)
        return
      }

      const video = videoRef?.current
      if (!video || video.readyState < 2) return

      // Canvas sizing: use explicit props if provided, else derive from video + res scale
      const resScale = window.RES_SCALE ?? 1
      const W = propW ?? Math.max(1, Math.round((video.videoWidth  || 640) * resScale))
      const H = propH ?? Math.max(1, Math.round((video.videoHeight || 480) * resScale))
      if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H }

      // Fast mode: skip effects every other frame
      frameCount.current++
      const skipEffects = window.FAST_MODE && (frameCount.current % 2 === 0)

      // Input FPS limiter
      const inFps = window.INPUT_FPS ?? 9999
      const inputReady = video.currentTime !== lastVideoTime.current &&
        (inFps >= 9999 || nowMs - lastInputMs.current >= 1000 / inFps)
      if (inputReady) { lastVideoTime.current = video.currentTime; lastInputMs.current = nowMs }

      // Landmarks
      let { faceResults, handResults, poseResults } = landmarkRef?.current ?? {}
      if (window.PRESERVE_DATA) {
        if (faceResults?.faceLandmarks?.length)  lastFaceRes.current = faceResults
        else if (lastFaceRes.current)            faceResults = lastFaceRes.current
        if (handResults?.landmarks?.length)      lastHandRes.current = handResults
        else if (lastHandRes.current)            handResults = lastHandRes.current
        if (poseResults?.landmarks?.length)      lastPoseRes.current = poseResults
        else if (lastPoseRes.current)            poseResults = lastPoseRes.current
      }
      const isWC = isWebcamProp?.current ?? false

      // Mirror landmarks to match the horizontally-flipped webcam image
      const _mirrorGroup = (groups) => isWC
        ? groups.map(lms => lms.map(lm => ({ ...lm, x: 1 - lm.x })))
        : groups
      const _mirrorOne = (lms) => isWC && lms
        ? lms.map(lm => ({ ...lm, x: 1 - lm.x }))
        : lms

      const allFaceLMs = _mirrorGroup(
        (faceResults?.faceLandmarks ?? []).slice().sort((a, b) => _faceArea(b) - _faceArea(a))
      )
      const allHandLMs = _mirrorGroup(handResults?.landmarks ?? [])
      const poseLMs    = _mirrorOne(poseResults?.landmarks?.[0] ?? null)
      const faceLMs    = allFaceLMs[0] ?? null

      // Blendshapes: flatten first face's categories into {name: score} dict
      const faceBS = (() => {
        const cats = faceResults?.faceBlendshapes?.[0]?.categories
        if (!cats) return null
        const d = {}
        for (const c of cats) d[c.categoryName] = c.score
        return d
      })()

      // Hand FX offset
      const handLMs = allHandLMs[0] ?? null
      if (handLMs && window.HAND_FX_CONTROL && !window.MOUSE_FX_CONTROL) {
        const tip = handLMs[8], sens = window.HAND_FX_SENSITIVITY ?? 1.5
        window.FX_OFFSET = { x: (tip.x - 0.5) * W * sens, y: (tip.y - 0.5) * H * sens }
      } else if (!window.MOUSE_FX_CONTROL && !window.HAND_FX_CONTROL) {
        window.FX_OFFSET = { x: 0, y: 0 }
      }

      // Input cache
      if (!inputCache.current || inputCache.current.width !== W || inputCache.current.height !== H) {
        inputCache.current = document.createElement('canvas')
        inputCache.current.width = W; inputCache.current.height = H
      }

      function drawVideoToCtx(targetCtx) {
        if (isWC) { targetCtx.save(); targetCtx.scale(-1, 1); targetCtx.drawImage(video, -W, 0, W, H); targetCtx.restore() }
        else targetCtx.drawImage(video, 0, 0, W, H)
      }

      // Background removal
      if (window.BG_REMOVE && faceLMs && window.FACE_OVAL?.length) {
        if (!bgOffCanvas.current || bgOffCanvas.current.width !== W) {
          bgOffCanvas.current = document.createElement('canvas')
          bgOffCanvas.current.width = W; bgOffCanvas.current.height = H
          bgLastFrame.current = document.createElement('canvas')
          bgLastFrame.current.width = W; bgLastFrame.current.height = H
        }
        const oc = bgOffCanvas.current.getContext('2d')
        oc.clearRect(0, 0, W, H); oc.save()
        let fx = 0, fy = 0
        for (const lm of faceLMs) { fx += lm.x; fy += lm.y }
        fx /= faceLMs.length; fy /= faceLMs.length
        const EXP = 1.32, oval = window.FACE_OVAL
        oc.beginPath()
        const si0 = oval[0].start ?? oval[0][0]
        oc.moveTo((fx + (faceLMs[si0].x - fx) * EXP) * W, (fy + (faceLMs[si0].y - fy) * EXP) * H)
        for (const c of oval) {
          const ei = c.end ?? c[1]
          oc.lineTo((fx + (faceLMs[ei].x - fx) * EXP) * W, (fy + (faceLMs[ei].y - fy) * EXP) * H)
        }
        oc.closePath(); oc.clip(); drawVideoToCtx(oc); oc.restore()
        bgLastFrame.current.getContext('2d').drawImage(bgOffCanvas.current, 0, 0)
        bgLastFaceMs.current = performance.now()
        if (inputReady) {
          const ic = inputCache.current.getContext('2d')
          ic.clearRect(0, 0, W, H)
          ic.drawImage(bgOffCanvas.current, 0, 0)
        }
        ctx.clearRect(0, 0, W, H); ctx.drawImage(inputCache.current, 0, 0)
      } else if (window.BG_REMOVE && bgLastFrame.current && (performance.now() - bgLastFaceMs.current) < 5000) {
        if (inputReady) {
          const ic = inputCache.current.getContext('2d')
          ic.clearRect(0, 0, W, H)
          ic.drawImage(bgLastFrame.current, 0, 0)
        }
        ctx.clearRect(0, 0, W, H); ctx.drawImage(inputCache.current, 0, 0)
      } else {
        if (inputReady) {
          const ic = inputCache.current.getContext('2d')
          ic.clearRect(0, 0, W, H); drawVideoToCtx(ic)
        }
        ctx.drawImage(inputCache.current, 0, 0)
      }

      // Frame interpolation
      if (window.INTERP_SMOOTH) {
        if (!interpCurr.current || interpCurr.current.width !== W) {
          interpPrev.current = document.createElement('canvas')
          interpPrev.current.width = W; interpPrev.current.height = H
          interpCurr.current = document.createElement('canvas')
          interpCurr.current.width = W; interpCurr.current.height = H
          interpPrev.current.getContext('2d').drawImage(ctx.canvas, 0, 0)
          interpCurr.current.getContext('2d').drawImage(ctx.canvas, 0, 0)
          interpLastMs.current = nowMs; interpPrevTime.current = lastVideoTime.current
        }
        if (lastVideoTime.current !== interpPrevTime.current) {
          if (interpLastMs.current > 0)
            interpInterval.current = interpInterval.current * 0.85 + (nowMs - interpLastMs.current) * 0.15
          interpLastMs.current = nowMs; interpPrevTime.current = lastVideoTime.current
          interpPrev.current.getContext('2d').drawImage(interpCurr.current, 0, 0)
          interpCurr.current.getContext('2d').drawImage(ctx.canvas, 0, 0)
        }
        const t = Math.min(1, (nowMs - interpLastMs.current) / Math.max(8, interpInterval.current))
        ctx.clearRect(0, 0, W, H)
        ctx.globalAlpha = 1; ctx.drawImage(interpPrev.current, 0, 0)
        ctx.globalAlpha = t; ctx.drawImage(interpCurr.current, 0, 0)
        ctx.globalAlpha = 1
      }

      // 3D rotation
      const rotSpeed = window.GLOBAL_ROT_SPEED ?? 0
      if (rotSpeed) globalRotAngle.current = (globalRotAngle.current + rotSpeed / 60) % (Math.PI * 2)
      const rotA = globalRotAngle.current
      const rotFaceLMs = rotA ? _rotateGroupY(allFaceLMs, rotA) : allFaceLMs
      const rotHandLMs = rotA ? _rotateGroupY(allHandLMs, rotA) : allHandLMs
      const rotPoseLMs = rotA && poseLMs ? _rotateOneY(poseLMs, rotA) : poseLMs

      // Face-mask snapshot
      const faceMaskMode = window.PIXEL_TARGET_MODE === 'face-mask' && faceLMs
      if (faceMaskMode) {
        if (!snapBefore.current || snapBefore.current.width !== W) {
          snapBefore.current = document.createElement('canvas')
          snapBefore.current.width = W; snapBefore.current.height = H
          snapAfter.current = document.createElement('canvas')
          snapAfter.current.width = W; snapAfter.current.height = H
        }
        snapBefore.current.getContext('2d').drawImage(ctx.canvas, 0, 0)
      }

      // Base frame for LayerMerger
      if (!baseFrame.current || baseFrame.current.width !== W) {
        baseFrame.current = document.createElement('canvas')
        baseFrame.current.width = W; baseFrame.current.height = H
      }
      baseFrame.current.getContext('2d').drawImage(ctx.canvas, 0, 0)
      window._baseFrame = baseFrame.current  // expose for external access

      // Apply effects chain
      const p = makeP(ctx, W, H)
      const chain = effectsChainRef?.current ?? []
      const _3dCats  = new Set(['DRAW', 'FACE'])
      const isPuppet = e => e.label === 'Puppet FX' || e.label === 'Puppet Model'

      const applyFx = (effect) => {
        const use3d = rotA && _3dCats.has(effect.category)
        ctx.globalCompositeOperation = effect.blendMode ?? 'source-over'
        try {
          effect.apply(p,
            use3d ? rotFaceLMs : allFaceLMs,
            use3d ? rotHandLMs : allHandLMs,
            use3d ? rotPoseLMs : poseLMs,
            faceBS)
        } catch (err) { console.warn(`[${effect.label}]`, err.message ?? err) }
        ctx.globalCompositeOperation = 'source-over'
      }

      if (!skipEffects) {
      for (const effect of chain) {
        if (effect.enabled === false || !isPuppet(effect)) continue
        ctx.globalCompositeOperation = effect.blendMode ?? 'source-over'
        try { effect.apply(p, rotFaceLMs, rotHandLMs, rotPoseLMs, faceBS) } catch (_) {}
        ctx.globalCompositeOperation = 'source-over'
      }

      const nonPuppet = chain.filter(e => e.enabled !== false && !isPuppet(e))
      const mergerIdx = nonPuppet.findIndex(e => e.label === 'Layer Merger')

      if (mergerIdx === -1) {
        for (const effect of nonPuppet) applyFx(effect)
      } else {
        const merger = nonPuppet[mergerIdx]
        for (let i = 0; i < mergerIdx; i++) applyFx(nonPuppet[i])
        if (!merger._btm || merger._btm.width !== W) {
          merger._btm = document.createElement('canvas'); merger._btm.width = W; merger._btm.height = H
          merger._top = document.createElement('canvas'); merger._top.width = W; merger._top.height = H
        }
        merger._btm.getContext('2d').drawImage(ctx.canvas, 0, 0)
        ctx.clearRect(0, 0, W, H); ctx.drawImage(baseFrame.current, 0, 0)
        for (let i = mergerIdx + 1; i < nonPuppet.length; i++) applyFx(nonPuppet[i])
        merger._top.getContext('2d').drawImage(ctx.canvas, 0, 0)
        ctx.clearRect(0, 0, W, H); ctx.drawImage(merger._btm, 0, 0)
        ctx.save()
        ctx.globalCompositeOperation = merger.values.mode
        ctx.globalAlpha = merger.values.opacity ?? 1
        ctx.drawImage(merger._top, 0, 0)
        ctx.restore()
      }  // end merger else
      }  // end if (!skipEffects)

      // Face-mask composite
      if (faceMaskMode) {
        snapAfter.current.getContext('2d').drawImage(ctx.canvas, 0, 0)
        ctx.drawImage(snapBefore.current, 0, 0)
        ctx.save(); ctx.beginPath()
        const oval = window.FACE_OVAL
        if (oval?.length) {
          const si = oval[0].start ?? oval[0][0]
          ctx.moveTo(faceLMs[si].x * W, faceLMs[si].y * H)
          for (const c of oval) { const ei = c.end ?? c[1]; ctx.lineTo(faceLMs[ei].x * W, faceLMs[ei].y * H) }
          ctx.closePath(); ctx.clip()
        }
        ctx.drawImage(snapAfter.current, 0, 0); ctx.restore()
      }

      // Movie overlays
      for (let oi = 0; oi < (window.MOVIE_OVERLAYS ?? []).length; oi++) {
        const ov = window.MOVIE_OVERLAYS[oi]
        if (!ov.visible || !ov.el || ov.el.readyState < 2) continue
        ctx.save(); ctx.globalAlpha = ov.opacity
        ctx.drawImage(ov.el, Math.round(ov.x), Math.round(ov.y), Math.round(ov.w), Math.round(ov.h))
        ctx.restore()
        if (window._OVERLAY_SELECTED === oi) {
          ctx.save(); ctx.strokeStyle = 'rgba(45,122,80,0.9)'; ctx.lineWidth = 2
          ctx.setLineDash([6, 3]); ctx.strokeRect(ov.x, ov.y, ov.w, ov.h); ctx.setLineDash([])
          ctx.fillStyle = '#2d7a50'; ctx.fillRect(ov.x + ov.w - 14, ov.y + ov.h - 14, 14, 14)
          ctx.restore()
        }
      }

      // Audio reactivity
      if (window.AUDIO_REACT && audioHook) {
        const norm = audioHook.tick()
        const bar  = document.getElementById('audio-level-bar')
        if (bar) bar.style.width = (norm * 100).toFixed(1) + '%'
      }

      // Cache output
      lastOutputMs.current = nowMs
      if (!outputCache.current || outputCache.current.width !== W) {
        outputCache.current = document.createElement('canvas')
        outputCache.current.width = W; outputCache.current.height = H
      }
      outputCache.current.getContext('2d').drawImage(ctx.canvas, 0, 0)
      window._outputCache = outputCache.current  // expose for external access

      // Frame buffer recording
      if (window.FRAME_BUF_MODE === 'recording' && frameBuffer) {
        const count = frameBuffer.pushFrame(canvas)
        const el = document.getElementById('frame-buf-status')
        if (el) el.textContent = `● Recording ${count}/${frameBuffer.bufSize}…`
      }
    }

    rafRef.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(rafRef.current)
  }, [videoRef, landmarkRef, effectsChainRef, audioHook, frameBuffer, isWebcamProp, propW, propH])

  // Canvas mouse interaction
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let dragging = false, dragX = 0, dragY = 0, baseOff = { x: 0, y: 0 }
    let ovIA = null

    const clientToCanvas = (cx, cy) => {
      const r = canvas.getBoundingClientRect()
      return { x: (cx - r.left) * (canvas.width / r.width), y: (cy - r.top) * (canvas.height / r.height) }
    }

    canvas.addEventListener('mousedown', (e) => {
      const px = clientToCanvas(e.clientX, e.clientY)
      const ovs = window.MOVIE_OVERLAYS ?? [], sel = window._OVERLAY_SELECTED ?? -1
      if (sel >= 0 && sel < ovs.length) {
        const ov = ovs[sel]
        if (px.x >= ov.x + ov.w - 16 && px.y >= ov.y + ov.h - 16) {
          ovIA = { mode: 'resize', idx: sel, startX: e.clientX, startY: e.clientY, startW: ov.w, startH: ov.h }
          e.preventDefault(); return
        }
        if (px.x >= ov.x && px.x <= ov.x + ov.w && px.y >= ov.y && px.y <= ov.y + ov.h) {
          ovIA = { mode: 'move', idx: sel, startX: e.clientX, startY: e.clientY, startOvX: ov.x, startOvY: ov.y }
          e.preventDefault(); return
        }
      }
      for (let i = ovs.length - 1; i >= 0; i--) {
        const ov = ovs[i]; if (!ov.visible) continue
        if (px.x >= ov.x && px.x <= ov.x + ov.w && px.y >= ov.y && px.y <= ov.y + ov.h) {
          window._OVERLAY_SELECTED = i
          ovIA = { mode: 'move', idx: i, startX: e.clientX, startY: e.clientY, startOvX: ov.x, startOvY: ov.y }
          e.preventDefault(); return
        }
      }
      if (window._OVERLAY_SELECTED >= 0) window._OVERLAY_SELECTED = -1
      if (!window.MOUSE_FX_CONTROL) return
      dragging = true; dragX = e.clientX; dragY = e.clientY; baseOff = { ...(window.FX_OFFSET ?? { x: 0, y: 0 }) }
      e.preventDefault()
    })
    const onMove = (e) => {
      if (ovIA) {
        const ia = ovIA, ov = (window.MOVIE_OVERLAYS ?? [])[ia.idx]; if (!ov) { ovIA = null; return }
        const r = canvas.getBoundingClientRect()
        const dx = (e.clientX - ia.startX) * (canvas.width / r.width)
        const dy = (e.clientY - ia.startY) * (canvas.height / r.height)
        if (ia.mode === 'move') { ov.x = ia.startOvX + dx; ov.y = ia.startOvY + dy }
        else { ov.w = Math.max(40, ia.startW + dx); ov.h = Math.max(24, ia.startH + dy) }
        return
      }
      if (!dragging || !window.MOUSE_FX_CONTROL) return
      window.FX_OFFSET = { x: baseOff.x + (e.clientX - dragX), y: baseOff.y + (e.clientY - dragY) }
    }
    const onUp = () => { ovIA = null; dragging = false }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup',   onUp)
    canvas.addEventListener('dblclick', () => { if (window.MOUSE_FX_CONTROL) window.FX_OFFSET = { x: 0, y: 0 } })
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'auto', display: 'block', ...style }}
    />
  )
})

export default EffectsCanvas
