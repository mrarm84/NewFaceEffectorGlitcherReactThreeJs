// useLandmarker.js — MediaPipe face / hand / pose detection hook
// Mirrors the detection logic from the original app.js (no p5 dependency)

import { useRef, useCallback } from 'react'
import { FilesetResolver, FaceLandmarker, HandLandmarker, PoseLandmarker } from '@mediapipe/tasks-vision'

const WASM_PATH = '/wasm'

async function _tryCreate(createFn, gpuOpts, cpuOpts) {
  try {
    return await createFn(gpuOpts)
  } catch {
    console.warn('[MediaPipe] GPU failed, falling back to CPU')
    return await createFn(cpuOpts)
  }
}

export function useLandmarker({ onResults }) {
  const faceRef = useRef(null)
  const handRef = useRef(null)
  const poseRef = useRef(null)
  const lastVideoTimeRef = useRef(-1)
  const rafRef = useRef(null)
  const videoRef = useRef(null)
  const onResultsRef = useRef(onResults)
  onResultsRef.current = onResults

  const initFace = useCallback(async (modelBuffer = null) => {
    const vision = await FilesetResolver.forVisionTasks(WASM_PATH)
    const makeOpts = (delegate) => ({
      baseOptions: {
        delegate,
        ...(modelBuffer
          ? { modelAssetBuffer: modelBuffer }
          : { modelAssetPath: '/models/face_landmarker.task' }),
      },
      runningMode: 'VIDEO',
      numFaces: 2,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: false,
    })
    if (faceRef.current) faceRef.current.close()
    faceRef.current = await _tryCreate(
      (o) => FaceLandmarker.createFromOptions(vision, o),
      makeOpts('GPU'),
      makeOpts('CPU'),
    )
    // expose for effects / Three scene
    window.FACE_TESSELATION = FaceLandmarker.FACE_LANDMARKS_TESSELATION
    window.FACE_OVAL        = FaceLandmarker.FACE_LANDMARKS_FACE_OVAL
  }, [])

  const initHand = useCallback(async (modelBuffer = null) => {
    const vision = await FilesetResolver.forVisionTasks(WASM_PATH)
    const makeOpts = (delegate) => ({
      baseOptions: {
        delegate,
        ...(modelBuffer
          ? { modelAssetBuffer: modelBuffer }
          : { modelAssetPath: '/models/hand_landmarker.task' }),
      },
      runningMode: 'VIDEO',
      numHands: 2,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5,
    })
    if (handRef.current) handRef.current.close()
    handRef.current = await _tryCreate(
      (o) => HandLandmarker.createFromOptions(vision, o),
      makeOpts('GPU'),
      makeOpts('CPU'),
    )
    window.HAND_CONNECTIONS = HandLandmarker.HAND_CONNECTIONS
  }, [])

  const initPose = useCallback(async (modelBuffer = null) => {
    const vision = await FilesetResolver.forVisionTasks(WASM_PATH)
    const makeOpts = (delegate) => ({
      baseOptions: {
        delegate,
        ...(modelBuffer
          ? { modelAssetBuffer: modelBuffer }
          : { modelAssetPath: '/models/pose_landmarker.task' }),
      },
      runningMode: 'VIDEO',
      numPoses: 1,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5,
      outputSegmentationMasks: false,
    })
    if (poseRef.current) poseRef.current.close()
    poseRef.current = await _tryCreate(
      (o) => PoseLandmarker.createFromOptions(vision, o),
      makeOpts('GPU'),
      makeOpts('CPU'),
    )
    window.POSE_CONNECTIONS = PoseLandmarker.POSE_CONNECTIONS
  }, [])

  const startDetection = useCallback((videoEl) => {
    // Cancel any existing loop before starting a new one
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
    videoRef.current = videoEl
    lastVideoTimeRef.current = -1  // reset so first frame is always processed

    const detect = () => {
      const video = videoRef.current
      if (!video || video.readyState < 2) {
        rafRef.current = requestAnimationFrame(detect)
        return
      }

      const nowMs = performance.now()
      if (video.currentTime !== lastVideoTimeRef.current) {
        lastVideoTimeRef.current = video.currentTime

        let faceResults = null
        let handResults = null
        let poseResults = null

        if (faceRef.current) {
          try { faceResults = faceRef.current.detectForVideo(video, nowMs) } catch (_) {}
        }
        if (handRef.current) {
          try { handResults = handRef.current.detectForVideo(video, nowMs) } catch (_) {}
        }
        if (poseRef.current) {
          try { poseResults = poseRef.current.detectForVideo(video, nowMs) } catch (_) {}
        }

        onResultsRef.current({ faceResults, handResults, poseResults })
      }

      rafRef.current = requestAnimationFrame(detect)
    }

    detect()
  }, [])

  const stopDetection = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
  }, [])

  return { initFace, initHand, initPose, startDetection, stopDetection }
}
