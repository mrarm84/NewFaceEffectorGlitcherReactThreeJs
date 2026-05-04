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
  const sceneRef = useRef(null)
  const layerPlanes = useRef([]) // Array of { mesh, texture }

  useFrame((state) => {
    const { scene, camera } = state;
    sceneRef.current = scene;
    
    // ── Handle 3D Layers ───────────────────────────────────────────────────
    const layers = window._THREE_LAYERS || [];
    
    layers.forEach((layer, i) => {
      let lp = layerPlanes.current[i];
      if (!lp) {
        const tex = new THREE.CanvasTexture(layer.canvas);
        const mat = new THREE.MeshBasicMaterial({ 
          map: tex, 
          transparent: true, 
          side: THREE.DoubleSide,
          depthTest: true,
          depthWrite: false, // Don't write to depth buffer to avoid sorting issues with multiple transparent sheets
          blending: THREE.NormalBlending
        });
        const geom = new THREE.PlaneGeometry(1, 1);
        const mesh = new THREE.Mesh(geom, mat);
        scene.add(mesh);
        lp = { mesh, texture: tex };
        layerPlanes.current[i] = lp;
      }
      
      const { mesh, texture } = lp;
      const { z, opacity, scale, billboard, rotationX, rotationY, rotationZ } = layer.params;
      
      texture.needsUpdate = true;
      mesh.visible = true;
      
      // Position: 0,0,0 is world center. Camera is usually at +Z.
      // Spread them along the Z axis relative to the center.
      mesh.position.set(0, 0, z / 100); 
      
      // Scaling: Calculate size to roughly fill the screen at Z=0
      // 1280px width -> ~4 units wide at distance 5
      const baseScale = layer.canvas.width / 320; 
      const aspect = layer.canvas.width / layer.canvas.height;
      mesh.scale.set(scale * baseScale, (scale * baseScale) / aspect, 1);
      
      if (billboard) {
        mesh.quaternion.copy(camera.quaternion);
      } else {
        mesh.rotation.set(rotationX, rotationY, rotationZ);
      }
      
      mesh.material.opacity = opacity;
    });

    for (let i = layers.length; i < layerPlanes.current.length; i++) {
      if (layerPlanes.current[i]) layerPlanes.current[i].mesh.visible = false;
    }
    window._THREE_LAYERS = [];

    // ── Original Face Landmark Logic ────────────────────────────────────────
    const inf = morphRef.current
    if (!inf) return

    const face = landmarkRef.current?.faceResults?.faceLandmarks?.[0]
    if (!face) return

    const m = computeMorphValues(face)
    if (!m) return

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
      style={{ background: bgColor, imageRendering: 'pixelated' }}
    >
      <SceneContent glbUrl={glbUrl} landmarkRef={landmarkRef} />
      {showStats && <Stats />}
    </Canvas>
  )
}

