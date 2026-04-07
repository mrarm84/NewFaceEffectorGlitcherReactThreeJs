// useAudioReact.js — Microphone analyser + beat detection for audio reactivity.
// Runs its own internal requestAnimationFrame loop when active.
import { useRef, useState, useCallback, useEffect } from 'react'

export function useAudioReact({ effectsChainRef } = {}) {
  const analyserRef  = useRef(null)
  const freqDataRef  = useRef(null)
  const rafRef       = useRef(null)
  const lastPeakRef  = useRef(0)
  const peakTimerRef = useRef(null)
  const activeRef    = useRef(false)
  const peakCbRef    = useRef(null)

  const [isActive,   setIsActive]   = useState(false)
  const [audioLevel, setAudioLevel] = useState(0)
  const [isPeaking,  setIsPeaking]  = useState(false)

  const audioCtxRef  = useRef(null)

  const stopAudio = useCallback(() => {
    activeRef.current = false
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
    if (peakTimerRef.current) { clearTimeout(peakTimerRef.current); peakTimerRef.current = null }
    if (audioCtxRef.current) {
      try { audioCtxRef.current.close() } catch (e) {}
      audioCtxRef.current = null
    }
    setIsActive(false)
    setIsPeaking(false)
    setAudioLevel(0)
  }, [])

  // Fix: The previous version was executing stopAudio on mount.
  // This correctly registers stopAudio as the cleanup function.
  useEffect(() => {
    return () => stopAudio()
  }, [stopAudio])

  const initAudio = useCallback(async (audioPeakFireFn) => {
    if (activeRef.current && audioCtxRef.current?.state === 'running') return true
    try {
      const stream   = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)()
      audioCtxRef.current = audioCtx
      
      const src      = audioCtx.createMediaStreamSource(stream)
      const analyser = audioCtx.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.5
      src.connect(analyser)
      
      analyserRef.current = analyser
      freqDataRef.current = new Uint8Array(analyser.frequencyBinCount)
      peakCbRef.current   = audioPeakFireFn ?? null
      
      if (audioCtx.state === 'suspended') await audioCtx.resume()
      
      activeRef.current   = true
      setIsActive(true)

      const loop = () => {
        if (!activeRef.current) return
        const an = analyserRef.current
        const fd = freqDataRef.current
        if (!an || !fd) return

        an.getByteFrequencyData(fd)
        
        // Calculate norm (mix of RMS and Peak)
        let sum = 0, mx = 0
        for (let i = 0; i < fd.length; i++) {
          sum += fd[i]
          if (fd[i] > mx) mx = fd[i]
        }
        const rms = (sum / fd.length) / 255
        const peak = mx / 255
        const norm = (rms * 0.3 + peak * 0.7)
        
        // We update the global and local level ref without triggering a React re-render every frame.
        // The AudioMeter and EffectsCanvas will pick this up via refs or tick().
        window.AUDIO_LEVEL = norm

        const isReactEnabled = window.AUDIO_REACT ?? false
        const threshold = (window.AUDIO_SENSITIVITY ?? 20) / 100
        const now = performance.now()
        
        if (isReactEnabled && norm > threshold && now - lastPeakRef.current > 110) {
          lastPeakRef.current = now
          setIsPeaking(true)
          if (peakTimerRef.current) clearTimeout(peakTimerRef.current)
          peakTimerRef.current = setTimeout(() => setIsPeaking(false), 200)
          
          const cb = peakCbRef.current
          if (typeof cb === 'function') cb(norm)
          else if (effectsChainRef && effectsChainRef.current) _peakFire(effectsChainRef.current)
        }

        rafRef.current = requestAnimationFrame(loop)
      }
      loop()
      return true
    } catch (err) {
      console.error('[Audio] Init failed:', err)
      return false
    }
  }, [effectsChainRef])

  const tick = useCallback(() => {
    const an = analyserRef.current
    const fd = freqDataRef.current
    if (!an || !fd) return 0
    an.getByteFrequencyData(fd)
    let sum = 0, mx = 0
    for (let i = 0; i < fd.length; i++) {
      sum += fd[i]
      if (fd[i] > mx) mx = fd[i]
    }
    return (sum / fd.length) * 0.3 / 255 + (mx / 255) * 0.7
  }, [])

  return {
    initAudio,
    audioLevel,
    isPeaking,
    isActive,
    stopAudio,
    init: initAudio,
    level: audioLevel,
    analyserRef,
    freqDataRef,
    tick,
  }
}

function _peakFire(chain) {
  if (!chain || !chain.length) return
  const all = []
  for (const effect of chain) {
    if (effect.enabled === false) continue
    for (const [key, def] of Object.entries(effect.params))
      all.push({ effect, key, def })
  }
  if (!all.length) return

  // Shuffle
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]]
  }

  // Nudge half of the params
  for (const { effect, key, def } of all.slice(0, Math.ceil(all.length / 2))) {
    const cur = parseFloat(effect.values[key])
    if (isNaN(cur) || def.type === 'select' || def.type === 'text') continue
    
    // Nudge by 2-5% of range for more visibility
    const amount = 0.02 + Math.random() * 0.03
    const delta = (def.max - def.min) * amount * (Math.random() > 0.5 ? 1 : -1)
    const newVal = Math.max(def.min, Math.min(def.max, parseFloat((cur + delta).toFixed(6))))
    
    effect.values[key] = newVal
    
    // Direct DOM update for UI feedback
    if (effect._sliderEls?.[key]) effect._sliderEls[key].value = newVal
    if (effect._labelEls?.[key])  effect._labelEls[key].textContent = newVal.toFixed(2)
  }
}

export default useAudioReact
