// useVideoSource.js — Manages webcam / file / screen / YouTube video sources.
import { useRef, useState, useCallback } from 'react'

export function useVideoSource() {
  const videoRef       = useRef(null)
  const [label,     setLabel]     = useState('No source')
  const [isWebcam,  setIsWebcam]  = useState(false)
  const [isLooping, setIsLooping] = useState(true)
  const _camStream    = useRef(null)
  const _screenStream = useRef(null)
  const [nativeSize, setNativeSize] = useState({ w: 640, h: 480 })

  const _attach = useCallback((vid, lbl, webcam = false) => {
    videoRef.current = vid
    setLabel(lbl)
    setIsWebcam(webcam)
    setNativeSize({ w: vid.videoWidth || 640, h: vid.videoHeight || 480 })
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
    _attach(vid, `Webcam ${vid.videoWidth || reqW}×${vid.videoHeight || reqH}`, true)
    return vid
  }, [_stopCam, _stopScreen, _attach])

  const stopWebcam = useCallback(() => {
    _stopCam()
    videoRef.current = null
    setLabel('No source')
    setIsWebcam(false)
  }, [_stopCam])

  const loadMediaFile = useCallback((file) => new Promise((resolve, reject) => {
    _stopCam(); _stopScreen()
    const url = URL.createObjectURL(file)
    const isImg = file.type.startsWith('image/')

    if (isImg) {
      const img = new Image()
      img.onload = () => {
        setNativeSize({ w: img.width || 640, h: img.height || 480 })
        // Wrap image in a dummy object that mimics a video element for the canvas draw loop
        const dummy = {
          tagName: 'IMG',
          src: url,
          videoWidth: img.width,
          videoHeight: img.height,
          readyState: 4,
          play: () => {},
          pause: () => {},
          addEventListener: (name, cb) => { if (name === 'loadeddata') cb() },
          removeEventListener: () => {}
        }
        _attach(dummy, file.name, false)
        resolve(dummy)
      }
      img.onerror = () => reject(new Error('Image load failed'))
      img.src = url
    } else {
      const vid = document.createElement('video')
      vid.src = url
      vid.loop = true; vid.muted = true; vid.playsInline = true
      vid.addEventListener('loadeddata', () => {
        vid.play()
        _attach(vid, file.name, false)
        resolve(vid)
      }, { once: true })
      vid.addEventListener('error', () => reject(new Error('Video load failed')), { once: true })
    }
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
    _attach(vid, `Screen ${vid.videoWidth || 1280}×${vid.videoHeight || 720}`, false)
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
  const stopAll = useCallback(() => {
    _stopCam(); _stopScreen()
    videoRef.current = null
    setLabel('No source')
    setIsWebcam(false)
    setNativeSize({ w: 640, h: 480 })
  }, [_stopCam, _stopScreen])

  return {
    videoRef, label, isWebcam, isLooping, nativeSize,
    startWebcam, stopWebcam, loadMediaFile,
    startScreenCapture, stopScreenCapture: _stopScreen,
    loadYouTube, play, pause, toggleLoop, stopAll,
  }
}
