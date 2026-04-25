// ThreeScene.jsx — Three.js scene using React Three Fiber + GLB model with morph-target steering
// Morph targets driven by face landmarks (eye blink, jaw open) — same approach as nazarisych/control-3d-model

import { useRef, useEffect, Suspense, Component } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { OrbitControls, useGLTF, Environment, Stats } from '@react-three/drei'
import * as THREE from 'three'

// ── Error boundary so a bad GLB URL doesn't crash the whole app ───────────────
class GlbErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null } }
  static getDerivedStateFromError(e) { return { error: e } }
  componentDidUpdate(prev) { if (prev.url !== this.props.url) this.setState({ error: null }) }
  render() {
    if (this.state.error) return null   // silently drop — console already has the error
    return this.props.children
  }
}

// ── Morph-target helpers ──────────────────────────────────────────────────────
function _dist(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2)
}

function computeMorphValues(faceLandmarks) {
  if (!faceLandmarks || faceLandmarks.length === 0) return null

  const kp = faceLandmarks

  // Jaw open: ratio of lip height to lip width
  const lipW  = _dist(kp[62], kp[292])
  const lipH  = _dist(kp[13],  kp[14])
  const jaw   = lipW > 0 ? Math.min(1, (lipH / lipW) * 3) : 0

  // Left eye blink
  const leW   = _dist(kp[33],  kp[133])
  const leH   = _dist(kp[159], kp[145])
  const leR   = leW > 0 ? leH / leW : 0
  let leftEye = leR < 0.23 ? leR : leR < 0.3 ? 1 - leR * 2 : 1 - leR * 3
  leftEye     = Math.max(0, Math.min(1, leftEye))

  // Right eye blink
  const reW    = _dist(kp[362], kp[263])
  const reH    = _dist(kp[386], kp[374])
  const reR    = reW > 0 ? reH / reW : 0
  let rightEye = reR < 0.23 ? 1 : reR < 0.3 ? 1 - reR * 2 : 1 - reR * 3
  rightEye     = Math.max(0, Math.min(1, rightEye))

  return { leftEye, rightEye, jaw }
}

// ── GLB model component ───────────────────────────────────────────────────────
function GlbModel({ url, morphRef }) {
  const { scene } = useGLTF(url)
  const morphMeshRef = useRef(null)

  useEffect(() => {
    // Find first mesh with morph targets
    scene.traverse(obj => {
      if (obj.isMesh && obj.morphTargetInfluences && !morphMeshRef.current) {
        morphMeshRef.current = obj
        morphRef.current = obj.morphTargetInfluences
        console.log('[GLB] morph targets:', Object.keys(obj.morphTargetDictionary ?? {}))
      }
    })
  }, [scene, morphRef])

  return <primitive object={scene} />
}

// ── Scene root (inside Canvas) ────────────────────────────────────────────────
function SceneContent({ glbUrl, landmarkRef }) {
  const morphRef = useRef(null)

  useFrame(() => {
    const inf = morphRef.current
    if (!inf) return

    const face = landmarkRef.current?.faceResults?.faceLandmarks?.[0]
    if (!face) return

    const m = computeMorphValues(face)
    if (!m) return

    // inf[0] = left eye, inf[1] = right eye, inf[2] = jaw — adjust indices for your GLB
    if (inf.length > 0) inf[0] = THREE.MathUtils.lerp(inf[0], m.leftEye,  0.2)
    if (inf.length > 1) inf[1] = THREE.MathUtils.lerp(inf[1], m.rightEye, 0.2)
    if (inf.length > 2) inf[2] = THREE.MathUtils.lerp(inf[2], m.jaw,      0.2)
  })

  return (
    <>
      <Environment preset="warehouse" />
      <OrbitControls
        enableDamping
        minDistance={2.5}
        maxDistance={5}
        minAzimuthAngle={-Math.PI / 2}
        maxAzimuthAngle={ Math.PI / 2}
        maxPolarAngle={Math.PI / 1.8}
        target={[0, 0.15, -0.2]}
      />
      {glbUrl && (
        <GlbErrorBoundary url={glbUrl}>
          <Suspense fallback={null}>
            <GlbModel url={glbUrl} morphRef={morphRef} />
          </Suspense>
        </GlbErrorBoundary>
      )}
    </>
  )
}

// ── Public component ──────────────────────────────────────────────────────────
export default function ThreeScene({ glbUrl = null, landmarkRef, showStats = false, bgColor = '#666' }) {
  return (
    <Canvas
      camera={{ position: [-1.8, 0.8, 3], fov: 45, near: 1, far: 20 }}
      gl={{ toneMapping: THREE.ACESFilmicToneMapping, antialias: true, preserveDrawingBuffer: true }}
      style={{ background: bgColor }}
    >
      <SceneContent glbUrl={glbUrl} landmarkRef={landmarkRef} />
      {showStats && <Stats />}
    </Canvas>
  )
}

