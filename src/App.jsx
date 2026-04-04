// App.jsx — Face Effector Glitcher (Three React edition)
import { useRef, useState, useCallback, useEffect } from 'react'
import VideoCapture   from './components/VideoCapture'
import ThreeScene     from './components/ThreeScene'
import EffectsCanvas  from './components/EffectsCanvas'
import Panel          from './components/Panel'
import { useVideoSource } from './hooks/useVideoSource'
import { useAudioReact  } from './hooks/useAudioReact'
import { useFrameBuffer  } from './hooks/useFrameBuffer'
import './App.css'

const BUILT_IN_MODELS = [
  '/models/objects/BrainStem.glb',
  '/models/objects/Box.glb',
  '/models/objects/Duck.glb',
]

export default function App() {
  const effectsChainRef = useRef([])
  const landmarkRef     = useRef({ faceResults: null, handResults: null, poseResults: null })
  const videoCaptureRef = useRef(null)
  const isWebcamRef     = useRef(false)

  const videoSource = useVideoSource()
  const audioHook   = useAudioReact({ effectsChainRef })
  const frameBuffer = useFrameBuffer()

  const [glbUrl, setGlbUrl]             = useState(null)
  const [serverModels, setServerModels] = useState([])
  const [showStats, setShowStats]       = useState(false)
  const [modelsReady, setModelsReady]   = useState(false)
  const [panelOpen, setPanelOpen]       = useState(true)
  const [canvasSize, setCanvasSize]     = useState(100)  // display size %

  useEffect(() => { isWebcamRef.current = videoSource.isWebcam }, [videoSource.isWebcam])

  useEffect(() => {
    fetch('/api/objects').then(r => r.json()).then(files => {
      if (files?.length) setServerModels(files.map(f => `/models/objects/${f}`))
    }).catch(() => {})
  }, [])

  const modelList = serverModels.length ? serverModels : BUILT_IN_MODELS

  const handleResults = useCallback(({ faceResults, handResults, poseResults }) => {
    landmarkRef.current = { faceResults, handResults, poseResults }
    if (!modelsReady) setModelsReady(true)
  }, [modelsReady])

  return (
    <div className="app">
      <VideoCapture
        ref={videoCaptureRef}
        onResults={handleResults}
        videoSourceRef={videoSource.videoRef}
      />

      <div className="scene-wrap">
        {glbUrl && (
          <ThreeScene glbUrl={glbUrl} landmarkRef={landmarkRef} showStats={showStats} />
        )}
        <EffectsCanvas
          videoRef={videoSource.videoRef}
          landmarkRef={landmarkRef}
          effectsChainRef={effectsChainRef}
          audioHook={audioHook}
          frameBuffer={frameBuffer}
          isWebcamRef={isWebcamRef}
          style={{
            width:  canvasSize + '%',
            height: canvasSize + '%',
            top:    `${(100 - canvasSize) / 2}%`,
            left:   `${(100 - canvasSize) / 2}%`,
            transformOrigin: 'center',
          }}
        />
        {!modelsReady && <div className="loading-overlay">Loading MediaPipe…</div>}

        {/* Panel toggle button — always visible on canvas edge */}
        <button
          className="panel-toggle"
          onClick={() => setPanelOpen(o => !o)}
          title={panelOpen ? 'Hide panel' : 'Show panel'}
        >
          {panelOpen ? '▶' : '◀'}
        </button>
      </div>

      {/* Sliding panel */}
      <aside className={`panel${panelOpen ? ' panel--open' : ''}`}>
        <Panel
          effectsChainRef={effectsChainRef}
          videoCaptureRef={videoCaptureRef}
          landmarkRef={landmarkRef}
          videoSource={videoSource}
          frameBuffer={frameBuffer}
          audioHook={audioHook}
          glbUrl={glbUrl}
          setGlbUrl={setGlbUrl}
          modelList={modelList}
          showStats={showStats}
          setShowStats={setShowStats}
          isWebcamRef={isWebcamRef}
          canvasSize={canvasSize}
          setCanvasSize={setCanvasSize}
        />
      </aside>
    </div>
  )
}
