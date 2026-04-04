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

  const stopAudio = useCallback(() => {
    activeRef.current = false
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
    if (peakTimerRef.current) { clearTimeout(peakTimerRef.current); peakTimerRef.current = null }
    setIsActive(false)
    setIsPeaking(false)
  }, [])

  useEffect(() => stopAudio, [stopAudio])

  const initAudio = useCallback(async (audioPeakFireFn) => {
    if (activeRef.current) return true
    try {
      const stream   = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)()
      const src      = audioCtx.createMediaStreamSource(stream)
      const analyser = audioCtx.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.8
      src.connect(analyser)
      analyserRef.current = analyser
      freqDataRef.current = new Uint8Array(analyser.frequencyBinCount)
      peakCbRef.current   = audioPeakFireFn ?? null
      activeRef.current   = true
      setIsActive(true)

      const loop = () => {
        if (!activeRef.current) return
        const an = analyserRef.current
        const fd = freqDataRef.current
        if (!an || !fd) return

        an.getByteFrequencyData(fd)
        let sum = 0
        for (let i = 0; i < fd.length; i++) sum += fd[i]
        const norm = (sum / fd.length) / 255
        setAudioLevel(norm)
        window.AUDIO_LEVEL = norm

        const threshold = (window.AUDIO_SENSITIVITY ?? 30) / 100
        const now = performance.now()
        if (norm > threshold && now - lastPeakRef.current > 80) {
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
      console.error('[Audio]', err)
      return false
    }
  }, [effectsChainRef])

  const tick = useCallback(() => {
    const an = analyserRef.current
    const fd = freqDataRef.current
    if (!an || !fd) return 0
    an.getByteFrequencyData(fd)
    let sum = 0
    for (let i = 0; i < fd.length; i++) sum += fd[i]
    return (sum / fd.length) / 255
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
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]]
  }
  for (const { effect, key, def } of all.slice(0, Math.ceil(all.length / 2))) {
    const cur = parseFloat(effect.values[key])
    if (isNaN(cur) || def.type === 'select' || def.type === 'text') continue
    const delta = (def.max - def.min) * 0.01 * (Math.random() > 0.5 ? 1 : -1)
    effect.values[key] = Math.max(def.min, Math.min(def.max,
      parseFloat((cur + delta).toFixed(6))))
  }
}

export default useAudioReact
