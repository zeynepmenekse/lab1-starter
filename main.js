// CS405 · Lab 1 

const canvas = document.querySelector('canvas');

// ---------------------------------------------------------------------------
// TODO 1 — get a device and configure the canvas
// ---------------------------------------------------------------------------
if (!navigator.gpu) {
  throw new Error('WebGPU is not supported here. Use Chrome and check chrome://gpu.');
}

// Adapter = the physical GPU; device = our connection to it
const adapter = await navigator.gpu.requestAdapter();
if (!adapter) throw new Error('No suitable GPU adapter found.');
const device = await adapter.requestDevice();

// Connect the <canvas> to the device, using the screen's preferred pixel format
const ctx = canvas.getContext('webgpu');
const format = navigator.gpu.getPreferredCanvasFormat();
ctx.configure({ device, format, alphaMode: 'opaque' });
console.log('WebGPU ready:', format);

// ---------------------------------------------------------------------------
// TODO 2 — a shader module and a render pipeline
// TODO 3 — a colour per vertex (VSOut struct, @location(0) colour)
// TODO 4 — uniforms: time (rotation)
// TODO 5 — a square (two triangles), correct aspect ratio, follows the mouse
// ---------------------------------------------------------------------------
const shaderCode = /* wgsl */ `
// TODO 4: data sent from JavaScript every frame (16 bytes = 4 floats)
struct Uniforms {
  time:   f32,    // seconds since start  -> rotation angle
  aspect: f32,    // canvas width / height -> stops the shape stretching
  mouse:  vec2f,  // mouse position in clip space (-1..1)
};
@group(0) @binding(0) var<uniform> u: Uniforms;

// TODO 3: the vertex shader outputs a position AND a colour
struct VSOut {
  @builtin(position) position: vec4f,
  @location(0) colour: vec3f,
};

@vertex
fn vs_main(@builtin(vertex_index) i: u32) -> VSOut {
  // TODO 5: a square = 4 corners, drawn as 2 triangles (6 vertices)
  var corners = array<vec2f, 4>(
    vec2f(-0.3, -0.3),  // 0 bottom-left
    vec2f( 0.3, -0.3),  // 1 bottom-right
    vec2f( 0.3,  0.3),  // 2 top-right
    vec2f(-0.3,  0.3),  // 3 top-left
  );
  // TODO 3: one colour per corner
  var colours = array<vec3f, 4>(
    vec3f(1.0, 0.35, 0.35),  // red
    vec3f(0.35, 1.0, 0.45),  // green
    vec3f(0.35, 0.55, 1.0),  // blue
    vec3f(1.0, 0.9, 0.35),   // yellow
  );
  // Triangle 1 = corners 0,1,2   Triangle 2 = corners 0,2,3
  var indices = array<u32, 6>(0u, 1u, 2u, 0u, 2u, 3u);

  let k = indices[i];
  let p = corners[k];

  // STEP 6: the same rotation as TODO 4, written as a matrix.
  // WGSL's mat2x2f(...) takes COLUMNS, not rows.
  let a = u.time;
  let R = mat2x2f( cos(a), sin(a),    // column 0: where x-hat (1,0) lands
                  -sin(a), cos(a));   // column 1: where y-hat (0,1) lands
  let S = mat2x2f(1.5, 0.0,           // non-uniform scale: x * 1.5
                  0.0, 0.6);          //                    y * 0.6

  let rotated = R * p;                 // checkpoint 6: turns exactly like before

  // Then try ONE at a time (comment out the line above, uncomment one below):
  // let rotated = R * S * p;          // scale, then rotate: a turning rectangle
  // let rotated = S * R * p;          // rotate, then scale: it shears as it turns
  // let rotated = transpose(R) * p;   // R^-1 = R^T: spins the other way

  // TODO 5: divide x by the aspect ratio so the square isn't stretched,
  //         then move it to the mouse position
  let pos = vec2f(rotated.x / u.aspect, rotated.y) + u.mouse;

  var out: VSOut;
  out.position = vec4f(pos, 0.0, 1.0);
  out.colour = colours[k];
  return out;
}

@fragment
fn fs_main(v: VSOut) -> @location(0) vec4f {
  // The GPU interpolates the colour between corners -> smooth gradient
  return vec4f(v.colour, 1.0);
}
`;

const shaderModule = device.createShaderModule({ code: shaderCode });

const pipeline = device.createRenderPipeline({
  layout: 'auto',
  vertex:   { module: shaderModule, entryPoint: 'vs_main' },
  fragment: { module: shaderModule, entryPoint: 'fs_main', targets: [{ format }] },
  primitive: { topology: 'triangle-list' }, // every 3 vertices = 1 triangle
});

// TODO 4: uniform buffer (16 bytes, UNIFORM | COPY_DST) + bind group
const uniformBuffer = device.createBuffer({
  size: 16,
  usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
});
const bind = device.createBindGroup({
  layout: pipeline.getBindGroupLayout(0),
  entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
});
const uniforms = new Float32Array(4); // [time, aspect, mouseX, mouseY]

// TODO 5: track the mouse and convert pixels -> clip space (-1..1, y up)
let mouseX = 0;
let mouseY = 0;
canvas.addEventListener('pointermove', (e) => {
  const r = canvas.getBoundingClientRect();
  mouseX = ((e.clientX - r.left) / r.width) * 2 - 1;
  mouseY = -(((e.clientY - r.top) / r.height) * 2 - 1); // screen y points down, clip y points up
});

const t0 = performance.now();

function resize() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
}
window.addEventListener('resize', resize);
resize();

function frame() {
  // TODO 4 (continued): send this frame's values to the GPU
  uniforms[0] = (performance.now() - t0) / 1000; // time in seconds
  uniforms[1] = canvas.width / canvas.height;    // aspect ratio
  uniforms[2] = mouseX;
  uniforms[3] = mouseY;
  device.queue.writeBuffer(uniformBuffer, 0, uniforms);

  // TODO 1 (continued): record commands -> render pass that clears -> submit
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{
      view: ctx.getCurrentTexture().createView(),
      clearValue: { r: 0.12, g: 0.12, b: 0.18, a: 1 },
      loadOp: 'clear',
      storeOp: 'store',
    }],
  });

  // TODO 2 / 4 (continued): draw with our pipeline and uniforms
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bind);
  pass.draw(6); // TODO 5: 6 vertices = 2 triangles = 1 square

  pass.end();
  device.queue.submit([encoder.finish()]);

  requestAnimationFrame(frame);
}
frame();