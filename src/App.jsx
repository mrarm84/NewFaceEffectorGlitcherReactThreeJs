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
  '/models/objects/head_Avocado.glb',
  '/models/objects/head_BarramundiFish.glb',
  '/models/objects/facecap.glb',
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
  const [bgColor, setBgColor]           = useState(() => localStorage.getItem('faceGlitcher_bgColor') || '#000000')
  const [disableDetection, setDisableDetection] = useState(false)
  const [previewFormat, setPreviewFormat] = useState(null) // null, 'A1', 'A2', 'A3', 'A4', 'ORYG'

  const FORMAT_SIZES = {
    'A1': [7016, 9933],
    'A2': [4961, 7016],
    'A3': [3508, 4961],
    'A4': [2480, 3508]
  }

  useEffect(() => {
    localStorage.setItem('faceGlitcher_bgColor', bgColor)
    document.body.style.background = bgColor
  }, [bgColor])

  useEffect(() => { isWebcamRef.current = videoSource.isWebcam }, [videoSource.isWebcam])

  useEffect(() => {
    fetch('/api/objects').then(r => r.json()).then(files => {
      if (files?.length) {
        const filtered = files.filter(f => f.includes('_') || f === 'facecap.glb')
        setServerModels(filtered.map(f => `/models/objects/${f}`))
      }
    }).catch(() => {})
  }, [])

  const modelList = serverModels.length ? serverModels : BUILT_IN_MODELS

  const handleResults = useCallback(({ faceResults, handResults, poseResults }) => {
    landmarkRef.current = { faceResults, handResults, poseResults }
    if (!modelsReady) setModelsReady(true)
  }, [modelsReady])

  const aspect = videoSource.nativeSize.w / videoSource.nativeSize.h

  // ── Determine Container Styles ─────────────────────────────────────────────
  let containerStyle = {
    position: 'absolute',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    width:  canvasSize + '%',
    height: canvasSize + '%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'none'
  }

  let innerStyle = {
    position: 'relative',
    width: '100%',
    height: '100%',
    aspectRatio: aspect,
    maxHeight: '100%',
    maxWidth: '100%',
    pointerEvents: 'auto'
  }

  if (previewFormat) {
    const srcW = videoSource.nativeSize.w || 640
    const srcH = videoSource.nativeSize.h || 480
    const isPortrait = srcH > srcW
    
    let targetW, targetH
    if (previewFormat === 'ORYG') {
      const resScale = window.RES_SCALE ?? 1
      targetW = Math.round(srcW * resScale)
      targetH = Math.round(srcH * resScale)
    } else {
      const base = FORMAT_SIZES[previewFormat]
      targetW = isPortrait ? base[0] : base[1]
      targetH = isPortrait ? base[1] : base[0]
      const targetAspect = targetW / targetH
      if (aspect > targetAspect) {
        targetH = targetW / aspect
      } else {
        targetW = targetH * aspect
      }
    }

    containerStyle = {
      position: 'absolute',
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
      overflow: 'auto',
      display: 'block',
      pointerEvents: 'auto'
    }
    innerStyle = {
      position: 'relative',
      width: targetW + 'px',
      height: targetH + 'px',
      margin: '0 auto',
      pointerEvents: 'auto'
    }
  }

  return (
    <div className="app" style={{ background: bgColor }}>
      <VideoCapture
        ref={videoCaptureRef}
        onResults={handleResults}
        videoSourceRef={videoSource.videoRef}
        disableDetection={disableDetection}
      />

      <div className="scene-wrap" style={{ background: bgColor }}>
        <div className="canvas-container" style={containerStyle}>
          <div style={innerStyle}>
            {glbUrl && (
              <ThreeScene glbUrl={glbUrl} landmarkRef={landmarkRef} showStats={showStats} bgColor={bgColor} />
            )}
            <EffectsCanvas
              videoRef={videoSource.videoRef}
              landmarkRef={landmarkRef}
              effectsChainRef={effectsChainRef}
              audioHook={audioHook}
              frameBuffer={frameBuffer}
              isWebcamRef={isWebcamRef}
              bgColor={bgColor}
              previewFormat={previewFormat}
              style={{
                width:  '100%',
                height: '100%',
                top:    0,
                left:   0,
              }}
            />
          </div>
        </div>
        {!modelsReady && !disableDetection && <div className="loading-overlay">Loading MediaPipe…</div>}

        {previewFormat && (
          <div className="preview-indicator" style={{
            position: 'absolute',
            top: 10,
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'rgba(255,0,0,0.85)',
            color: '#fff',
            padding: '4px 14px',
            borderRadius: 20,
            fontSize: 10,
            zIndex: 100,
            pointerEvents: 'none',
            textTransform: 'uppercase',
            fontWeight: 'bold',
            letterSpacing: 1,
            boxShadow: '0 2px 10px rgba(0,0,0,0.5)'
          }}>
            1:1 Preview — {previewFormat}
          </div>
        )}

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
          bgColor={bgColor}
          setBgColor={setBgColor}
          disableDetection={disableDetection}
          setDisableDetection={setDisableDetection}
          previewFormat={previewFormat}
          setPreviewFormat={setPreviewFormat}
        />
      </aside>
    </div>
  )
}
