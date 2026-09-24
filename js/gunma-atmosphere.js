import * as THREE from '../lib/three.module.js';

// A single small repeating canopy mask replaces actual trees and shadow passes.
export function createCanopyShade() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, 128, 128);
  let seed = 20260924;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  // Wrap each leaf cluster across tile boundaries for seamless shadows.
  for (let i = 0; i < 65; i++) {
    const x = random()*128, y = random()*128;
    const rx = 3+random()*12, ry = 2+random()*5, angle = random()*Math.PI;
    ctx.fillStyle = `rgba(25,35,40,${0.10+random()*0.2})`;
    for (const dx of [-128, 0, 128]) for (const dy of [-128, 0, 128]) {
      ctx.beginPath();
      ctx.ellipse(x+dx, y+dy, rx, ry, angle, 0, Math.PI*2);
      ctx.fill();
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  const time = { value: 0 }, strength = { value: 1 };
  const materials = new WeakMap();
  return {
    material(source) {
      if (materials.has(source)) return materials.get(source);
      const material = source.clone();
      material.onBeforeCompile = (shader) => {
        shader.uniforms.canopyMap = { value: texture };
        shader.uniforms.canopyTime = time;
        shader.uniforms.canopyStrength = strength;
        shader.vertexShader = 'varying vec3 canopyWorld;\n' + shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace('#include <worldpos_vertex>',
          '#include <worldpos_vertex>\ncanopyWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
        shader.fragmentShader = 'uniform sampler2D canopyMap;\nuniform float canopyTime, canopyStrength;\nvarying vec3 canopyWorld;\n' + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `
          #include <color_fragment>
          vec2 shadeUV = canopyWorld.xz * 0.055;
          shadeUV.x += sin(canopyTime*0.35+canopyWorld.z*0.08)*0.012;
          float shade = texture2D(canopyMap, shadeUV).r;
          float grove = smoothstep(-0.4,0.65,sin(canopyWorld.x*0.035+sin(canopyWorld.z*0.048)));
          diffuseColor.rgb *= 1.0 - (1.0-shade)*0.72*grove*canopyStrength;
        `);
      };
      material.customProgramCacheKey = () => 'gunma-canopy-v1';
      materials.set(source, material);
      return material;
    },
    update(dt, dusk) { time.value += dt; strength.value = 1 - dusk; },
  };
}

// Three shallow, world-anchored cloud layers: no extra textures or postprocessing.
// Fixed valley elevation: the road climbs through and above the sea of clouds.
export function createMountainAtmosphere(scene, elevation) {
  const group = new THREE.Group();
  group.name = 'gunma-valley-clouds';
  const uniforms = {
    time: { value: 0 },
    tint: { value: new THREE.Color() },
  };
  const geometry = new THREE.PlaneGeometry(1500, 1500);
  for (let i = 0; i < 3; i++) {
    const material = new THREE.ShaderMaterial({
      uniforms: { ...uniforms, layer: { value: i } },
      vertexShader: `
        varying vec3 world;
        void main() {
          vec4 p = modelMatrix * vec4(position, 1.0);
          world = p.xyz;
          gl_Position = projectionMatrix * viewMatrix * p;
        }`,
      fragmentShader: `
        uniform float time, layer;
        uniform vec3 tint;
        varying vec3 world;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
        float noise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f*f*(3.0-2.0*f);
          return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),
                     mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);
        }
        void main() {
          vec2 p = world.xz * 0.012 + vec2(time*0.008, time*0.003) + layer*7.3;
          float n = noise(p)*0.58 + noise(p*2.1)*0.28 + noise(p*4.3)*0.14;
          float distanceXZ = length(world.xz-cameraPosition.xz);
          float edge = 1.0-smoothstep(420.0,680.0,distanceXZ);
          // Fade near the eye and at grazing angles to avoid visible sheet edges.
          float nearFade = smoothstep(18.0,65.0,length(world-cameraPosition));
          float heightFade = smoothstep(0.0,12.0,cameraPosition.y-world.y);
          float alpha = smoothstep(0.25,0.78,n)*0.42*edge*nearFade*heightFade;
          gl_FragColor = vec4(tint*(0.87+n*0.17), alpha);
        }`,
      transparent: true, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = elevation + i * 5;
    group.add(mesh);
  }
  scene.add(group);
  return {
    update(dt, camera, color, hidden) {
      uniforms.time.value += dt;
      uniforms.tint.value.copy(color);
      group.visible = !hidden;
      // Shader noise stays in world coordinates, even as the coverage follows X/Z.
      group.position.x = camera.position.x;
      group.position.z = camera.position.z;
    },
  };
}
