// VideoCapture.jsx
import { useEffect, useRef, useImperativeHandle, forwardRef, useState } from 'react'
import { useLandmarker } from '../hooks/useLandmarker'

const VideoCapture = forwardRef(function VideoCapture({ onResults, videoSourceRef }, ref) {
  const [faceStatus, setFaceStatus] = useState('initializing')
  const [handStatus, setHandStatus] = useState('initializing')
  const [poseStatus, setPoseStatus] = useState('no pose model')
  const [faceReady,  setFaceReady]  = useState(false)
  const [handReady,  setHandReady]  = useState(false)
  const [poseReady,  setPoseReady]  = useState(false)

  const { initFace, initHand, initPose, startDetection, stopDetection } = useLandmarker({ onResults })

  const doInitFace = async (buf) => {
    setFaceStatus('loading'); setFaceReady(false)
    try { await initFace(buf ?? null); setFaceStatus('ready'); setFaceReady(true) }
    catch (err) { setFaceStatus('error: ' + (err.message?.slice(0, 28) ?? '?')); console.error('[Face]', err) }
  }
  const doInitHand = async (buf) => {
    setHandStatus('loading'); setHandReady(false)
    try { await initHand(buf ?? null); setHandStatus('ready'); setHandReady(true) }
    catch (err) { setHandStatus('error: ' + (err.message?.slice(0, 28) ?? '?')); console.error('[Hand]', err) }
  }
  const doInitPose = async (buf) => {
    setPoseStatus('loading'); setPoseReady(false)
    try { await initPose(buf ?? null); setPoseStatus('ready'); setPoseReady(true) }
    catch (err) { setPoseStatus('error: ' + (err.message?.slice(0, 28) ?? '?')); console.error('[Pose]', err) }
  }

  useImperativeHandle(ref, () => ({
    reloadFace: doInitFace,
    reloadHand: doInitHand,
    reloadPose: doInitPose,
    videoEl: () => videoSourceRef?.current ?? null,
    getStatus: () => ({ faceStatus, handStatus, poseStatus, faceReady, handReady, poseReady }),
  }), [faceStatus, handStatus, poseStatus, faceReady, handReady, poseReady])

  useEffect(() => {
    let cancelled = false
    doInitFace().then(() => { if (!cancelled) doInitHand() }).catch(console.error)
    return () => { cancelled = true; stopDetection() }
  }, [])

  useEffect(() => {
    const lastVideoRef = { current: null }
    const poll = setInterval(() => {
      const video = videoSourceRef?.current
      if (video && video !== lastVideoRef.current && video.readyState >= 2) {
        lastVideoRef.current = video
        startDetection(video)
      }
    }, 300)
    return () => clearInterval(poll)
  }, [videoSourceRef, startDetection])

  return null
})

export default VideoCapture