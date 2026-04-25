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
    width: propW, height: propH, style, bgColor, previewFormat },
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

      const outFps = window.OUTPUT_FPS ?? 240
      // 0 = stopped, -1 = unlimited
      if (outFps === 0) {
        if (outputCache.current) ctx.drawImage(outputCache.current, 0, 0)
        return
      }
      const outLimited = outFps > 0 && outFps <= 240
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
      // If no video, we still loop to allow effects (like 3D model) to render on black
      const resScale = window.RES_SCALE ?? 1
      const srcW = video?.videoWidth  || 640
      const srcH = video?.videoHeight || 480

      const FORMAT_SIZES = {
        'A1': [7016, 9933], 'A2': [4961, 7016], 'A3': [3508, 4961], 'A4': [2480, 3508]
      }

      let W, H
      if (previewFormat) {
        const isPortrait = srcH > srcW
        if (previewFormat === 'ORYG') {
          W = Math.round(srcW * resScale)
          H = Math.round(srcH * resScale)
          window.EXPORT_SCALE = 1
        } else {
          const base = FORMAT_SIZES[previewFormat]
          let targetW = isPortrait ? base[0] : base[1]
          let targetH = isPortrait ? base[1] : base[0]
          const aspect = srcW / srcH
          const targetAspect = targetW / targetH
          if (aspect > targetAspect) {
            targetH = targetW / aspect
          } else {
            targetW = targetH * aspect
          }
          W = Math.round(targetW)
          H = Math.round(targetH)
          window.EXPORT_SCALE = W / srcW
        }
      } else {
        W = propW ?? Math.max(1, Math.round(srcW * resScale))
        H = propH ?? Math.max(1, Math.round(srcH * resScale))
        window.EXPORT_SCALE = 1
      }

      if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H }

      // Fast mode: skip effects every other frame
      frameCount.current++
      const skipEffects = window.FAST_MODE && (frameCount.current % 2 === 0)

      // Input FPS limiter
      const inFps = Math.min(window.INPUT_FPS ?? 240, 240)
      const videoTime = video?.currentTime ?? 0
      const inputReady = videoTime !== lastVideoTime.current &&
        (nowMs - lastInputMs.current >= 1000 / inFps)
      if (inputReady) { lastVideoTime.current = videoTime; lastInputMs.current = nowMs }

      renderFrame(ctx, W, H, skipEffects, inputReady)

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

    function renderFrame(ctx, W, H, skipEffects = false, inputReady = true, skipClear = false) {
      const nowMs = performance.now()
      const video = videoRef?.current

      // landmarks
      let { faceResults, handResults, poseResults } = landmarkRef?.current ?? {}
      if (window.PRESERVE_DATA) {
        if (faceResults?.faceLandmarks?.length)  lastFaceRes.current = faceResults
        else if (lastFaceRes.current)            faceResults = lastFaceRes.current
        if (handResults?.landmarks?.length)      lastHandRes.current = handResults
        else if (lastHandRes.current)            handResults = lastHandRes.current
        if (poseResults?.landmarks?.length)      lastPoseRes.current = poseResults
        else if (lastPoseRes.current)            poseResults = lastPoseRes.current
      }

      const clear = (c) => {
        // ALWAYS clear with transparency in EffectsCanvas so ThreeScene is visible behind
        c.clearRect(0, 0, W, H)
      }

      // Base background fill
      if (!skipClear) clear(ctx)

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
        if (!video) return
        if (isWC) { targetCtx.save(); targetCtx.scale(-1, 1); targetCtx.drawImage(video, -W, 0, W, H); targetCtx.restore() }
        else targetCtx.drawImage(video, 0, 0, W, H)
      }

      // Base frame for LayerMerger
      if (!baseFrame.current || baseFrame.current.width !== W) {
        baseFrame.current = document.createElement('canvas')
        baseFrame.current.width = W; baseFrame.current.height = H
      }
      baseFrame.current.getContext('2d').drawImage(ctx.canvas, 0, 0)
      window._baseFrame = baseFrame.current

      // Apply effects chain
      const p = makeP(ctx, W, H)
      const chain = effectsChainRef?.current ?? []
      const isPuppet = e => e.label === 'Puppet FX' || e.label === 'Puppet Model'

      const applyFx = (effect) => {
        ctx.globalCompositeOperation = effect.blendMode ?? 'source-over'
        try {
          effect.apply(p, allFaceLMs, allHandLMs, poseLMs, faceBS)
        } catch (err) { console.warn(`[${effect.label}]`, err.message ?? err) }
        ctx.globalCompositeOperation = 'source-over'
      }

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

      // Background removal
      const nonPuppet = chain.filter(e => e.enabled !== false && !isPuppet(e))
      
      // If LoadObject3D is present, move it to the very start of the active chain 
      // so other effects (pixelate, glitch, etc) can process the 3D model pixels.
      const obj3dIdx = nonPuppet.findIndex(e => e.label === 'Load Object 3D')
      if (obj3dIdx > 0) {
        const [obj] = nonPuppet.splice(obj3dIdx, 1)
        nonPuppet.unshift(obj)
      }

      const firstEffect = nonPuppet[0]
      const hideBackground = firstEffect?.label === 'Load Object 3D' && 
                             firstEffect?.values?.hideBG && 
                             firstEffect?._three?.model

      if (hideBackground) {
        clear(ctx)
      } else {
        if (inputReady) {
          const ic = inputCache.current.getContext('2d')
          ic.clearRect(0, 0, W, H); drawVideoToCtx(ic)
        }
        ctx.drawImage(inputCache.current, 0, 0)
      }

      if (!skipEffects) {
        // Draw Puppet effects first (they usually draw directly on the canvas)
        for (const effect of chain) {
          if (effect.enabled === false || !isPuppet(effect)) continue
          applyFx(effect)
        }

        // Apply remaining effects in order
        const mergerIdx = nonPuppet.findIndex(e => e.label === 'Layer Merger')
        if (mergerIdx === -1) {
          for (const effect of nonPuppet) applyFx(effect)
        } else {
          const merger = nonPuppet[mergerIdx]
          // Apply effects before merger
          for (let i = 0; i < mergerIdx; i++) applyFx(nonPuppet[i])
          
          if (!merger._btm || merger._btm.width !== W) {
            merger._btm = document.createElement('canvas'); merger._btm.width = W; merger._btm.height = H
            merger._top = document.createElement('canvas'); merger._top.width = W; merger._top.height = H
          }
          // Snapshot state for bottom layer
          merger._btm.getContext('2d').clearRect(0, 0, W, H)
          merger._btm.getContext('2d').drawImage(ctx.canvas, 0, 0)
          
          // Clear and apply effects after merger
          clear(ctx); ctx.drawImage(baseFrame.current, 0, 0)
          for (let i = mergerIdx + 1; i < nonPuppet.length; i++) applyFx(nonPuppet[i])
          
          // Snapshot state for top layer
          merger._top.getContext('2d').clearRect(0, 0, W, H)
          merger._top.getContext('2d').drawImage(ctx.canvas, 0, 0)
          
          // Blend them
          clear(ctx); ctx.drawImage(merger._btm, 0, 0)
          ctx.save()
          ctx.globalCompositeOperation = merger.values.mode
          ctx.globalAlpha = merger.values.opacity ?? 1
          ctx.drawImage(merger._top, 0, 0)
          ctx.restore()
        }
      }

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
    }

    window.exportOryg = () => {
      const video = videoRef?.current
      if (!video || video.readyState < 2) { alert('Video/Media not ready'); return }

      const W = canvasRef.current.width
      const H = canvasRef.current.height

      const exportCanvas = document.createElement('canvas')
      exportCanvas.width = W; exportCanvas.height = H
      const eCtx = exportCanvas.getContext('2d')

      // Fill background (same as preview)
      if (bgColor) {
        eCtx.fillStyle = bgColor
        eCtx.fillRect(0, 0, W, H)
      } else {
        eCtx.clearRect(0, 0, W, H)
      }

      console.log(`[Export] Rendering 1:1 original frame (${W}x${H})...`)
      
      // Capture 3D scene if present
      const threeCanvas = document.querySelector('.scene-wrap canvas:not(.effects-canvas-el)')
      if (threeCanvas) {
        try { eCtx.drawImage(threeCanvas, 0, 0, W, H) } catch (_) {}
      }

      // Draw effects ON TOP (no scaling needed for 1:1)
      renderFrame(eCtx, W, H, false, true, true) // skipClear = true

      try {
        const dataUrl = exportCanvas.toDataURL('image/png')
        const link = document.createElement('a')
        link.download = `face-effector-oryg-${Date.now()}.png`
        link.href = dataUrl
        link.click()
        console.log('[Export] Finished 1:1.')
      } catch (err) {
        console.error('[Export] 1:1 Failed:', err)
        alert('Export failed')
      }
    }

    window.exportImage = (format = 'A2') => {
      const video = videoRef?.current
      if (!video || video.readyState < 2) { alert('Video/Media not ready'); return }

      const srcW = video.videoWidth || 640
      const srcH = video.videoHeight || 480
      const srcAspect = srcW / srcH

      // Dimensions @ 300 DPI
      const sizes = {
        'A1': [7016, 9933], // 594 x 841 mm
        'A2': [4961, 7016], // 420 x 594 mm
        'A3': [3508, 4961], // 297 x 420 mm
        'A4': [2480, 3508]  // 210 x 297 mm
      }
      const base = sizes[format] || sizes['A2']

      // Match orientation to source aspect ratio
      const isPortrait = srcH > srcW
      const targetW = isPortrait ? base[0] : base[1]
      const targetH = isPortrait ? base[1] : base[0]
      const targetAspect = targetW / targetH

      // We want to fill the target format but keep the source aspect ratio.
      // Similar to "object-fit: contain" or "cover" logic? 
      // User said "maintain aspect ratio and look from preview".
      // Usually "contain" is safer for exports to not lose parts of image.
      
      let drawW = targetW
      let drawH = targetH
      let offX = 0
      let offY = 0

      if (srcAspect > targetAspect) {
        // Source is wider than target
        drawH = targetW / srcAspect
        offY = (targetH - drawH) / 2
      } else {
        // Source is taller than target
        drawW = targetH * srcAspect
        offX = (targetW - drawW) / 2
      }

      const exportCanvas = document.createElement('canvas')
      exportCanvas.width = targetW; exportCanvas.height = targetH
      const eCtx = exportCanvas.getContext('2d')

      // Fill background (same as preview)
      if (bgColor) {
        eCtx.fillStyle = bgColor
        eCtx.fillRect(0, 0, targetW, targetH)
      } else {
        eCtx.clearRect(0, 0, targetW, targetH)
      }

      console.log(`[Export] Rendering high-res ${format} (${targetW}x${targetH})...`)
      
      // Store original globals to restore later
      const oldOff = { ...window.FX_OFFSET }
      const oldRes = window.RES_SCALE ?? 1
      const liveW = canvasRef.current?.width || 1
      const scale = drawW / liveW
      
      window.EXPORT_SCALE = scale
      window.FX_OFFSET = { x: oldOff.x * scale, y: oldOff.y * scale }
      window.RES_SCALE = oldRes * scale

      // Create a temporary canvas specifically for the content (effects + video)
      // This avoids coordinate mismatches for getImageData/putImageData
      const tempCanvas = document.createElement('canvas')
      tempCanvas.width = drawW; tempCanvas.height = drawH
      const tCtx = tempCanvas.getContext('2d')

      // Draw ThreeScene to temp canvas if present
      const threeCanvas = document.querySelector('.scene-wrap canvas:not(.effects-canvas-el)')
      if (threeCanvas) {
        try { tCtx.drawImage(threeCanvas, 0, 0, drawW, drawH) } catch (_) {}
      }

      // Render effects onto the temp canvas
      renderFrame(tCtx, drawW, drawH, false, true, true)

      // Composite onto the main export canvas
      eCtx.drawImage(tempCanvas, offX, offY)

      // Restore globals
      window.EXPORT_SCALE = 1
      window.FX_OFFSET = oldOff
      window.RES_SCALE = oldRes

      try {
        const dataUrl = exportCanvas.toDataURL('image/jpeg', 0.95)
        const link = document.createElement('a')
        link.download = `face-effector-${format.toLowerCase()}-${Date.now()}.jpg`
        link.href = dataUrl
        link.click()
        console.log('[Export] Finished.')
      } catch (err) {
        console.error('[Export] Failed:', err)
        alert('Export failed (possibly canvas size limit or security)')
      }
    }

    rafRef.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(rafRef.current)
  }, [videoRef, landmarkRef, effectsChainRef, audioHook, frameBuffer, isWebcamProp, propW, propH, bgColor, previewFormat])

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
      className="effects-canvas-el"
      style={{
        position: 'absolute',
        width: '100%',
        height: '100%',
        objectFit: 'contain',
        pointerEvents: 'auto',
        display: 'block',
        ...style
      }}
    />
  )
})

export default EffectsCanvas
