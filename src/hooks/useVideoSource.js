// useVideoSource.js — Manages webcam / file / screen / YouTube video sources.
import { useRef, useState, useCallback } from 'react'

export function useVideoSource() {
  const videoRef       = useRef(null)
  const [label,     setLabel]     = useState('No source')
  const [isWebcam,  setIsWebcam]  = useState(false)
  const [isLooping, setIsLooping] = useState(true)
  const _camStream    = useRef(null)
  const _screenStream = useRef(null)
  const nativeSizeRef = useRef({ w: 640, h: 480 })

  const _attach = useCallback((vid, lbl, webcam = false) => {
    videoRef.current = vid
    setLabel(lbl)
    setIsWebcam(webcam)
  }, [])

  const _stopCam = useCallback(() => {
    _camStream.current?.getTracks().forEach(t => t.stop())
    _camStream.current = null
  }, [])

  const _stopScreen = useCallback(() => {
    _screenStream.current?.getTracks().forEach(t => t.stop())
    _screenStream.current = null
  }, [])

  const startWebcam = useCallback(async (resolution = '640x480') => {
    _stopCam(); _stopScreen()
    const [reqW, reqH] = resolution.split('x').map(Number)
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: reqW }, height: { ideal: reqH }, facingMode: 'user' },
    })
    _camStream.current = stream
    const vid = document.createElement('video')
    vid.srcObject = stream; vid.playsInline = true; vid.muted = true
    await new Promise(res => vid.addEventListener('loadeddata', res, { once: true }))
    vid.play()
    nativeSizeRef.current = { w: vid.videoWidth || reqW, h: vid.videoHeight || reqH }
    _attach(vid, `Webcam ${nativeSizeRef.current.w}×${nativeSizeRef.current.h}`, true)
    return vid
  }, [_stopCam, _stopScreen, _attach])

  const stopWebcam = useCallback(() => {
    _stopCam()
    videoRef.current = null
    setLabel('No source')
    setIsWebcam(false)
  }, [_stopCam])

  const loadVideoFile = useCallback((file) => new Promise(resolve => {
    _stopCam(); _stopScreen()
    const vid = document.createElement('video')
    vid.src = URL.createObjectURL(file)
    vid.loop = true; vid.muted = true; vid.playsInline = true
    vid.addEventListener('loadeddata', () => {
      nativeSizeRef.current = { w: vid.videoWidth || 640, h: vid.videoHeight || 480 }
      vid.play()
      _attach(vid, file.name, false)
      resolve(vid)
    }, { once: true })
  }), [_stopCam, _stopScreen, _attach])

  const startScreenCapture = useCallback(async () => {
    _stopCam(); _stopScreen()
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30 }, cursor: 'always' }, audio: false,
    })
    _screenStream.current = stream
    stream.getVideoTracks()[0].addEventListener('ended', () => {
      _screenStream.current = null; videoRef.current = null
      setLabel('No source'); setIsWebcam(false)
    })
    const vid = document.createElement('video')
    vid.srcObject = stream; vid.muted = true; vid.playsInline = true
    await new Promise(res => vid.addEventListener('loadeddata', res, { once: true }))
    vid.play()
    nativeSizeRef.current = { w: vid.videoWidth || 1280, h: vid.videoHeight || 720 }
    _attach(vid, `Screen ${nativeSizeRef.current.w}×${nativeSizeRef.current.h}`, false)
    return vid
  }, [_stopCam, _stopScreen, _attach])

  const loadYouTube = useCallback(async (url) => {
    _stopCam(); _stopScreen()
    const src = `/api/yt-stream?url=${encodeURIComponent(url)}`
    const probe = await fetch(src, { method: 'GET', headers: { Range: 'bytes=0-1023' } })
    if (!probe.ok && probe.status !== 206 && probe.status !== 200) {
      const txt = await probe.text().catch(() => '')
      throw new Error(txt || `Server error ${probe.status}`)
    }
    return new Promise((resolve, reject) => {
      const vid = document.createElement('video')
      vid.src = src; vid.loop = true; vid.muted = true; vid.playsInline = true
      vid.addEventListener('loadeddata', () => {
        nativeSizeRef.current = { w: vid.videoWidth || 1280, h: vid.videoHeight || 720 }
        vid.play(); _attach(vid, 'YouTube', false); resolve(vid)
      }, { once: true })
      vid.addEventListener('error', () => reject(new Error('Video error')), { once: true })
    })
  }, [_stopCam, _stopScreen, _attach])

  const play  = useCallback(() => { const v = videoRef.current; if (v) v.play() }, [])
  const pause = useCallback(() => { const v = videoRef.current; if (v) v.pause() }, [])
  const toggleLoop = useCallback(() => {
    setIsLooping(prev => {
      const next = !prev
      const v = videoRef.current; if (v) v.loop = next
      return next
    })
  }, [])
  const stopAll = useCallback(() => { _stopCam(); _stopScreen(); videoRef.current = null; setLabel('No source'); setIsWebcam(false) }, [_stopCam, _stopScreen])

  return {
    videoRef, label, isWebcam, isLooping, nativeSizeRef,
    startWebcam, stopWebcam, loadVideoFile,
    startScreenCapture, stopScreenCapture: _stopScreen,
    loadYouTube, play, pause, toggleLoop, stopAll,
  }
}
