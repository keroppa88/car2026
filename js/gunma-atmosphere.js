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

// Fixed valley elevation: the road climbs through and above the sea of clouds.
export function createMountainAtmosphere(scene, elevation, route, groundHeightAt) {
  const group = new THREE.Group();
  group.name = 'gunma-valley-clouds';
  const uniforms = {
    time: { value: 0 },
    tint: { value: new THREE.Color() },
  };
  // Three overlapping ridgelines share one mesh (576 triangles), with no trees,
  // collision surfaces or shadow maps. Fixed world positions preserve parallax.
  const bounds = new THREE.Box3().setFromPoints(route);
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const radius = Math.hypot(size.x, size.z) * 0.5 + 450;
  const ridgeVertices = [], ridgeShades = [], ridgeHeights = [], ridgeIndices = [];
  const segments = 96;
  for (let layer = 0; layer < 3; layer++) {
    for (let i = 0; i <= segments; i++) {
      const angle = i / segments * Math.PI * 2;
      const r = radius + layer * 85;
      const profile = 0.5 + 0.23*Math.sin(angle*5+layer*1.7)
        + 0.16*Math.sin(angle*11-layer) + 0.11*Math.sin(angle*19+layer);
      const top = bounds.max.y - 30 + layer*35 + profile*95;
      const x = center.x + Math.cos(angle)*r, z = center.z + Math.sin(angle)*r;
      ridgeVertices.push(x, elevation-140, z, x, top, z);
      ridgeShades.push(0.44+layer*0.16, 0.44+layer*0.16);
      ridgeHeights.push(0, 1);
      if (i < segments) {
        const a = layer*(segments+1)*2 + i*2;
        ridgeIndices.push(a,a+1,a+2,a+1,a+3,a+2);
      }
    }
  }
  const ridgeGeometry = new THREE.BufferGeometry();
  ridgeGeometry.setAttribute('position', new THREE.Float32BufferAttribute(ridgeVertices,3));
  ridgeGeometry.setAttribute('ridgeShade', new THREE.Float32BufferAttribute(ridgeShades,1));
  ridgeGeometry.setAttribute('ridgeHeight', new THREE.Float32BufferAttribute(ridgeHeights,1));
  ridgeGeometry.setIndex(ridgeIndices);
  const ridges = new THREE.Mesh(ridgeGeometry, new THREE.ShaderMaterial({
    uniforms,
    vertexShader: `
      attribute float ridgeShade, ridgeHeight;
      varying float shade, height;
      void main() {
        shade = ridgeShade; height = ridgeHeight;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
      }`,
    fragmentShader: `
      uniform vec3 tint;
      varying float shade, height;
      void main() {
        float haze = 1.0-smoothstep(0.18,0.92,height);
        vec3 mountain = tint * vec3(0.83,0.95,1.0) * shade;
        gl_FragColor = vec4(mix(mountain,tint,haze*0.88),1.0);
      }`,
    side: THREE.DoubleSide,
  }));
  ridges.name = 'gunma-distant-ridges';
  scene.add(ridges);
  // Wisps sit above both verges. All 128 soft billboards use one draw call and
  // one 64px mask, rather than a large particle system or individual tree meshes.
  const mistCanvas = document.createElement('canvas');
  mistCanvas.width = mistCanvas.height = 64;
  const mistCtx = mistCanvas.getContext('2d');
  for (let i = 0; i < 12; i++) {
    const x = 16 + (Math.sin(i*12.37)*0.5+0.5)*32;
    const y = 20 + (Math.cos(i*7.19)*0.5+0.5)*24;
    const gradient = mistCtx.createRadialGradient(x,y,0,x,y,15);
    gradient.addColorStop(0,'rgba(255,255,255,0.3)');
    gradient.addColorStop(1,'rgba(255,255,255,0)');
    mistCtx.fillStyle = gradient;
    mistCtx.fillRect(0,0,64,64);
  }
  const mistMask = new THREE.CanvasTexture(mistCanvas);
  const wisps = new THREE.InstancedMesh(new THREE.PlaneGeometry(1,1), new THREE.ShaderMaterial({
    uniforms: { ...uniforms, mistMask: { value: mistMask } },
    vertexShader: `
      uniform float time;
      varying vec2 mistUv;
      varying float mistRange;
      void main() {
        vec4 center = modelMatrix * instanceMatrix * vec4(0,0,0,1);
        center.x += sin(time*0.09+center.z*0.013)*2.0;
        center.z += cos(time*0.07+center.x*0.015)*1.5;
        mistRange = distance(center.xyz,cameraPosition);
        vec4 view = viewMatrix * center;
        view.xy += position.xy * vec2(length(instanceMatrix[0].xyz),length(instanceMatrix[1].xyz));
        mistUv = uv;
        gl_Position = projectionMatrix * view;
      }`,
    fragmentShader: `
      uniform sampler2D mistMask;
      uniform vec3 tint;
      varying vec2 mistUv;
      varying float mistRange;
      void main() {
        float fade = smoothstep(6.0,22.0,mistRange)*(1.0-smoothstep(110.0,190.0,mistRange));
        gl_FragColor = vec4(tint,texture2D(mistMask,mistUv).a*0.28*fade);
      }`,
    transparent: true, depthWrite: false,
  }),128);
  const transform = new THREE.Matrix4();
  for (let i = 0; i < 64; i++) {
    const index = Math.floor(i*route.length/64);
    const p = route[index], next = route[(index+1)%route.length];
    const dx = next.x-p.x, dz = next.z-p.z, length = Math.hypot(dx,dz);
    for (let side = 0; side < 2; side++) {
      const offset = (side ? 1 : -1)*(12+(i%4)*2);
      transform.makeScale(32+(i%5)*4,7+(i%3)*2,1);
      transform.setPosition(p.x+dz/length*offset,p.y+2.5,p.z-dx/length*offset);
      wisps.setMatrixAt(i*2+side,transform);
    }
  }
  wisps.name = 'gunma-roadside-wisps';
  // Billboard rotation and wind are shader-driven, outside the CPU bounds.
  wisps.frustumCulled = false;
  scene.add(wisps);
  // Cloud sea: one textured floor plus a few translucent mist sheets stacked
  // above it. Two draw calls in total, and only texture reads per pixel.
  let cloudSeed = 20260925;
  const cloudRandom = () => ((cloudSeed = (Math.imul(cloudSeed, 1664525) + 1013904223) >>> 0) / 4294967296);
  // Seamless 256px cloud pattern: soft blobs wrapped across the tile edges,
  // leaving gaps so the floor never reads as one solid sheet.
  const floorCanvas = document.createElement('canvas');
  floorCanvas.width = floorCanvas.height = 256;
  const floorCtx = floorCanvas.getContext('2d');
  for (let i = 0; i < 70; i++) {
    const x = cloudRandom() * 256, y = cloudRandom() * 256, r = 14 + cloudRandom() * 34;
    for (const dx of [-256, 0, 256]) for (const dy of [-256, 0, 256]) {
      const g = floorCtx.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, r);
      g.addColorStop(0, `rgba(255,255,255,${0.35 + cloudRandom() * 0.3})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      floorCtx.fillStyle = g;
      floorCtx.fillRect(x + dx - r, y + dy - r, r * 2, r * 2);
    }
  }
  const floorTexture = new THREE.CanvasTexture(floorCanvas);
  floorTexture.wrapS = floorTexture.wrapT = THREE.RepeatWrapping;
  // Rounded mist sheet: overlapping circles give an organic outline with no corners.
  const sheetCanvas = document.createElement('canvas');
  sheetCanvas.width = sheetCanvas.height = 128;
  const sheetCtx = sheetCanvas.getContext('2d');
  for (let i = 0; i < 14; i++) {
    const angle = cloudRandom() * Math.PI * 2, reach = cloudRandom() * 30;
    const x = 64 + Math.cos(angle) * reach, y = 64 + Math.sin(angle) * reach;
    const r = 18 + cloudRandom() * 16;
    const g = sheetCtx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,0.45)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    sheetCtx.fillStyle = g;
    sheetCtx.fillRect(0, 0, 128, 128);
  }
  const sheetTexture = new THREE.CanvasTexture(sheetCanvas);
  // Horizontal sheets seen edge-on would show as hard lines; fade them out
  // as the view grazes the surface.
  const cloudUniformsGlsl = `
    uniform sampler2D clearanceMap;
    uniform vec4 clearanceArea;`;
  const flatVertex = `
    varying vec3 cloudWorld;
    varying vec2 cloudUv;
    void main() {
      vec4 world = modelMatrix * INSTANCE vec4(position, 1.0);
      cloudWorld = world.xyz;
      cloudUv = uv;
      gl_Position = projectionMatrix * viewMatrix * world;
    }`;
  const grazeFade = `
    vec3 toCamera = cameraPosition - cloudWorld;
    float range = length(toCamera);
    float facing = smoothstep(0.02, 0.22, abs(toCamera.y) / range);
    float fade = facing * smoothstep(20.0, 60.0, range) * (1.0 - smoothstep(900.0, 1300.0, range));
    // Ground height here, decoded from the clearance map (+-10 m .. 40 m).
    vec2 clearanceUv = (cloudWorld.xz - clearanceArea.xy) / clearanceArea.z;
    float ground = clearanceArea.w - (texture2D(clearanceMap, clearanceUv).r * 50.0 - 10.0);
    fade *= smoothstep(2.0, 14.0, cloudWorld.y - ground);`;
  const floorRadius = Math.hypot(size.x, size.z) * 0.5 + 350;
  const floorY = elevation - 6;
  // Height of the cloud base above the ground, baked once into a 64px map.
  // Clouds thin out where the slopes rise into them, so there is no hard
  // line where the layer meets the terrain (no depth texture needed).
  const clearanceSize = 64;
  const clearanceData = new Uint8Array(clearanceSize * clearanceSize * 4);
  const mapMin = new THREE.Vector2(center.x - floorRadius, center.z - floorRadius);
  const mapSpan = floorRadius * 2;
  for (let iz = 0; iz < clearanceSize; iz++) {
    for (let ix = 0; ix < clearanceSize; ix++) {
      const x = mapMin.x + (ix + 0.5) / clearanceSize * mapSpan;
      const z = mapMin.y + (iz + 0.5) / clearanceSize * mapSpan;
      const clearance = groundHeightAt ? floorY - groundHeightAt(x, z) : 40;
      clearanceData[(iz * clearanceSize + ix) * 4] =
        THREE.MathUtils.clamp(Math.round((clearance + 10) / 50 * 255), 0, 255);
    }
  }
  const clearanceMap = new THREE.DataTexture(clearanceData, clearanceSize, clearanceSize);
  clearanceMap.magFilter = clearanceMap.minFilter = THREE.LinearFilter;
  clearanceMap.needsUpdate = true;
  Object.assign(uniforms, {
    clearanceMap: { value: clearanceMap },
    clearanceArea: { value: new THREE.Vector4(mapMin.x, mapMin.y, mapSpan, floorY) },
  });
  const floor = new THREE.Mesh(new THREE.CircleGeometry(floorRadius, 48), new THREE.ShaderMaterial({
    uniforms: { ...uniforms, floorTexture: { value: floorTexture } },
    vertexShader: flatVertex.replace('INSTANCE', ''),
    fragmentShader: `
      ${cloudUniformsGlsl}
      uniform sampler2D floorTexture;
      uniform vec3 tint;
      uniform float time;
      varying vec3 cloudWorld;
      varying vec2 cloudUv;
      void main() {
        ${grazeFade}
        float broad = texture2D(floorTexture, cloudWorld.xz / 320.0 + vec2(time * 0.0015, 0.0)).a;
        float fine = texture2D(floorTexture, cloudWorld.xz / 110.0 - vec2(0.0, time * 0.0025)).a;
        float density = broad * 1.2 + fine * 0.6;
        // Round outer rim instead of a square edge.
        float rim = 1.0 - smoothstep(0.55, 1.0, length(cloudUv * 2.0 - 1.0));
        float alpha = smoothstep(0.18, 0.75, density) * 0.9 * rim * fade;
        if (alpha < 0.01) discard;
        vec3 color = mix(tint * vec3(0.78, 0.82, 0.88), min(tint * 1.15, vec3(1.0)), fine);
        gl_FragColor = vec4(color, alpha);
      }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
  }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(center.x, floorY, center.z);
  floor.name = 'gunma-cloud-floor';
  group.add(floor);
  const sheetGeometry = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const sheetCount = 48;
  const sheets = new THREE.InstancedMesh(sheetGeometry, new THREE.ShaderMaterial({
    uniforms: { ...uniforms, sheetTexture: { value: sheetTexture } },
    vertexShader: flatVertex.replace('INSTANCE', 'instanceMatrix *'),
    fragmentShader: `
      ${cloudUniformsGlsl}
      uniform sampler2D sheetTexture;
      uniform vec3 tint;
      varying vec3 cloudWorld;
      varying vec2 cloudUv;
      void main() {
        ${grazeFade}
        float alpha = texture2D(sheetTexture, cloudUv).a * 0.7 * fade;
        if (alpha < 0.01) discard;
        gl_FragColor = vec4(min(tint * 1.08, vec3(1.0)), alpha);
      }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
  }), sheetCount);
  // Keep sheets off the slopes, where they would cut in with a straight edge.
  const clearOfGround = (x, y, z, reach) => !groundHeightAt
    || [[0, 0], [reach, 0], [-reach, 0], [0, reach], [0, -reach]]
      .every(([dx, dz]) => groundHeightAt(x + dx, z + dz) < y);
  const sheetRotation = new THREE.Quaternion(), sheetScale = new THREE.Vector3();
  const sheetPosition = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  let placed = 0;
  for (let attempt = 0; attempt < sheetCount * 15 && placed < sheetCount; attempt++) {
    const width = 90 + cloudRandom() * 130;
    const x = bounds.min.x - 200 + cloudRandom() * (size.x + 400);
    const z = bounds.min.z - 200 + cloudRandom() * (size.z + 400);
    const y = elevation - 3 + cloudRandom() * 24;
    if (!clearOfGround(x, y, z, width * 0.3)) continue;
    sheetRotation.setFromAxisAngle(up, cloudRandom() * Math.PI * 2);
    sheetScale.set(width, 1, width * (0.55 + cloudRandom() * 0.35));
    sheetPosition.set(x, y, z);
    transform.compose(sheetPosition, sheetRotation, sheetScale);
    sheets.setMatrixAt(placed++, transform);
  }
  sheets.count = placed;
  sheets.instanceMatrix.needsUpdate = true;
  sheets.frustumCulled = false;
  sheets.name = 'gunma-mist-sheets';
  group.add(sheets);
  scene.add(group);
  return {
    update(dt, camera, color, hidden) {
      uniforms.time.value += dt;
      uniforms.tint.value.copy(color);
      group.visible = !hidden;
      ridges.visible = !hidden;
      wisps.visible = !hidden;
      // The cloud floor and sheets stay anchored in the valley as the car moves.
    },
  };
}
