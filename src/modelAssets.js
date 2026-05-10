export const MODEL_ASSETS = [
  { file: 'antenna_BoxVertexColors.glb', label: 'Box Vertex Colors' },
  { file: 'animal_EmissiveStrengthTest.glb', label: 'Emissive Strength Test' },
  { file: 'cat_AnimatedMorphSphere.glb', label: 'Animated Morph Sphere' },
  { file: 'LightsPunctualLamp.glb', label: 'Lights Punctual Lamp' },
]

export const MODEL_FILES = MODEL_ASSETS.map(model => model.file)
export const MODEL_URLS = MODEL_ASSETS.map(model => `/models/objects/${model.file}`)
export const MODEL_OPTIONS = MODEL_ASSETS.map(model => [model.file, model.label])
