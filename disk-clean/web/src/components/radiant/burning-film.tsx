/*
  Burning Film from Radiant (https://github.com/pbakaus/radiant)
  MIT License
  Copyright (c) 2025 Paul Bakaus
  Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
  documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
  rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
  persons to whom the Software is furnished to do so, subject to the following conditions:
  The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
  Software.
  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
  WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
  COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
  OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/
import {useCanvasRenderer, type Renderer} from '@/lib/canvas-loop'

const VERTEX = `attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`

const FRAGMENT = `precision highp float;
uniform float u_time;
uniform vec2 u_res;
uniform float u_burnSpeed;
uniform float u_emberGlow;

float hash21(vec2 p) {
  p = fract(p * vec2(443.897, 441.423));
  p += dot(p, p + 19.19);
  return fract(p.x * p.y);
}

vec2 hash22(vec2 p) {
  vec3 a = fract(p.xyx * vec3(443.897, 441.423, 437.195));
  a += dot(a, a.yzx + 19.19);
  return fract((a.xx + a.yz) * a.zy);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  vec2 shift = vec2(100.0);
  mat2 rot = mat2(0.866, 0.5, -0.5, 0.866);
  for (int i = 0; i < 6; i++) {
    v += a * noise(p);
    p = rot * p * 2.0 + shift;
    a *= 0.5;
  }
  return v;
}

float warpedNoise(vec2 p, float t) {
  vec2 q = vec2(fbm(p + vec2(0.0, 0.0)), fbm(p + vec2(5.2, 1.3)));
  vec2 r = vec2(fbm(p + 4.0 * q + vec2(1.7, 9.2) + 0.05 * t), fbm(p + 4.0 * q + vec2(8.3, 2.8) + 0.06 * t));
  return fbm(p + 4.0 * r);
}

float emberNoise(vec2 p, float t) {
  float n1 = noise(p * 3.0 + vec2(t * 0.3, t * 0.2));
  float n2 = noise(p * 7.0 - vec2(t * 0.5, t * 0.15));
  float n3 = noise(p * 15.0 + vec2(t * 0.8, -t * 0.4));
  return n1 * 0.5 + n2 * 0.35 + n3 * 0.15;
}

float filmGrain(vec2 uv, float t) {
  return hash21(uv * u_res * 0.5 + fract(t * 137.0));
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  float t = u_time;

  float cycleDuration = 12.0 / max(u_burnSpeed, 0.1);
  float cycleT = mod(t, cycleDuration);
  float cyclePhase = cycleT / cycleDuration;
  float burnThreshold = mix(0.74, 0.5, smoothstep(0.0, 0.85, cyclePhase));
  float resetFade = smoothstep(0.88, 1.0, cyclePhase);
  float startFade = smoothstep(0.0, 0.05, cyclePhase);

  float aspect = u_res.x / u_res.y;
  vec2 noiseUV = uv * vec2(aspect, 1.0) * 2.5;
  float cycleIndex = floor(t / cycleDuration);
  vec2 cycleOffset = vec2(cycleIndex * 7.31, cycleIndex * 3.17);
  float burnNoise = warpedNoise(noiseUV + cycleOffset, cycleT * u_burnSpeed * 0.3);

  float burnAmount = smoothstep(burnThreshold, burnThreshold - 0.12, burnNoise);
  float edgeWidth = 0.06;
  float edgeInner = smoothstep(burnThreshold, burnThreshold - edgeWidth, burnNoise);
  float edgeMask = edgeInner * (1.0 - burnAmount * 0.7);
  float hotEdge = smoothstep(burnThreshold + 0.01, burnThreshold - 0.01, burnNoise)
                - smoothstep(burnThreshold - 0.01, burnThreshold - 0.04, burnNoise);
  hotEdge = max(hotEdge, 0.0);

  float grain = filmGrain(uv, t);
  vec3 filmBase = vec3(0.028, 0.03, 0.036);
  filmBase += (grain - 0.5) * 0.035;
  float scanline = sin(uv.y * u_res.y * 0.5) * 0.5 + 0.5;
  filmBase *= 0.95 + scanline * 0.05;

  vec3 whiteHot = vec3(0.72, 0.8, 0.9);
  vec3 glow = vec3(0.2, 0.26, 0.36);
  vec3 edgeTone = vec3(0.14, 0.17, 0.22);
  vec3 deepTone = vec3(0.06, 0.08, 0.12);

  vec3 edgeColor = mix(edgeTone, glow, smoothstep(0.0, 0.5, edgeMask));
  edgeColor = mix(edgeColor, whiteHot, hotEdge);
  float edgeNoise = noise(noiseUV * 8.0 + cycleOffset + t * 0.5);
  edgeColor *= 0.8 + edgeNoise * 0.4;
  edgeColor *= 0.85 + 0.15 * sin(t * 3.0 + burnNoise * 10.0);

  float ember = emberNoise(noiseUV, t);
  vec3 emberDark = vec3(0.0, 0.01, 0.02);
  vec3 emberLow = vec3(0.02, 0.035, 0.06);
  vec3 emberMid = vec3(0.1, 0.15, 0.24);
  vec3 emberHigh = vec3(0.4, 0.5, 0.66);
  vec3 emberColor = mix(emberDark, emberLow, smoothstep(0.2, 0.5, ember));
  emberColor = mix(emberColor, emberMid, smoothstep(0.55, 0.75, ember));
  emberColor = mix(emberColor, emberHigh, smoothstep(0.8, 0.95, ember) * 0.5);
  emberColor *= (0.7 + 0.3 * sin(t * 2.0 + ember * 8.0 + burnNoise * 5.0)) * u_emberGlow;
  float edgeProximity = smoothstep(0.3, 0.0, abs(burnNoise - burnThreshold + 0.15));
  emberColor += glow * edgeProximity * 0.2 * u_emberGlow;

  vec3 col = filmBase;
  float preheat = smoothstep(burnThreshold + 0.15, burnThreshold + 0.02, burnNoise) * (1.0 - burnAmount);
  col += deepTone * preheat * 0.4;
  col = mix(col, emberColor, burnAmount);
  col += edgeColor * edgeMask * 1.8;
  col += whiteHot * hotEdge * 1.2;

  float curl = noise(noiseUV * 20.0 + cycleOffset);
  float curlEdge = smoothstep(burnThreshold + 0.03, burnThreshold - 0.02, burnNoise) * (1.0 - burnAmount * 0.8);
  col += vec3(0.35, 0.45, 0.6) * curl * curlEdge * 0.3;

  for (float i = 0.0; i < 4.0; i++) {
    vec2 sparkPos = uv * vec2(aspect, 1.0) * (30.0 + i * 15.0);
    sparkPos.y -= t * (1.5 + i * 0.8);
    sparkPos.x += sin(t * (1.0 + i * 0.3) + i * 3.0) * 0.5;
    vec2 sparkId = floor(sparkPos);
    vec2 sparkFrac = fract(sparkPos) - 0.5;
    float sparkHash = hash21(sparkId + i * 100.0);
    float sparkActive = step(0.85, sparkHash);
    vec2 sparkOffset = hash22(sparkId + i * 50.0) - 0.5;
    float sparkSize = 0.03 + sparkHash * 0.02;
    float spark = smoothstep(sparkSize, sparkSize * 0.2, length(sparkFrac - sparkOffset * 0.3));
    spark *= (sin(t * 15.0 + sparkHash * 50.0) * 0.5 + 0.5) * sparkActive;
    spark *= smoothstep(0.6, 0.3, abs(burnNoise - burnThreshold));
    col += mix(glow, whiteHot, sparkHash) * spark * 0.6 * u_emberGlow;
  }

  vec2 vc = uv - 0.5;
  col *= pow(clamp(1.0 - dot(vc, vc) * 1.6, 0.0, 1.0), 0.6);
  col *= startFade;
  col *= 1.0 - resetFade;
  col = mix(col, col * vec3(0.92, 0.98, 1.08), 0.15);
  col = col / (1.0 + col * 0.2);
  col = pow(max(col, 0.0), vec3(0.95));

  vec3 page = vec3(0.039);
  col = mix(page, col, 0.8);
  float d = length((uv - 0.5) / vec2(0.46, 0.36));
  float scrim = d < 0.45 ? mix(0.85, 0.6, d / 0.45) : mix(0.6, 0.0, clamp((d - 0.45) / 0.55, 0.0, 1.0));
  col = mix(col, page, scrim);
  gl_FragColor = vec4(col, 1.0);
}`

const BURN_SPEED = 0.25
const EMBER_GLOW = 1.0
const START_SECONDS = 5
const STILL_SECONDS = 24
const RENDER_SCALE = 0.5
const PROBE_SIZE = 64
const PROBE_BUDGET_MS = 20

function compile(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type)
  if (!shader) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  return shader
}

function link(gl: WebGLRenderingContext) {
  const program = gl.createProgram()
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX)
  const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT)
  if (!program || !vertex || !fragment) return null
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)
  gl.deleteShader(vertex)
  gl.deleteShader(fragment)
  if (gl.getProgramParameter(program, gl.LINK_STATUS)) return program
  gl.deleteProgram(program)
  return null
}

function createBurningFilm(canvas: HTMLCanvasElement): Renderer | null {
  const gl = canvas.getContext('webgl', {alpha: false, antialias: false, preserveDrawingBuffer: false})
  if (!gl) return null
  const program = link(gl)
  if (!program) return null
  gl.useProgram(program)
  const buffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  const position = gl.getAttribLocation(program, 'a_pos')
  gl.enableVertexAttribArray(position)
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
  const time = gl.getUniformLocation(program, 'u_time')
  gl.uniform1f(gl.getUniformLocation(program, 'u_burnSpeed'), BURN_SPEED)
  gl.uniform1f(gl.getUniformLocation(program, 'u_emberGlow'), EMBER_GLOW)
  const resolution = gl.getUniformLocation(program, 'u_res')
  const started = performance.now()

  const draw = (seconds: number) => {
    gl.uniform1f(time, seconds)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }
  const resize = (width: number, height: number, dpr: number) => {
    const w = Math.max(1, Math.round(width * dpr))
    const h = Math.max(1, Math.round(height * dpr))
    if (canvas.width === w && canvas.height === h) return
    canvas.width = w
    canvas.height = h
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.uniform2f(resolution, canvas.width, canvas.height)
  }
  const dispose = () => {
    gl.deleteBuffer(buffer)
    gl.deleteProgram(program)
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
  const pixel = new Uint8Array(4)
  const timedStill = (size: number) => {
    resize(size, size, 1)
    const start = performance.now()
    draw(STILL_SECONDS)
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
    return performance.now() - start
  }
  timedStill(1)
  if (timedStill(PROBE_SIZE) > PROBE_BUDGET_MS) {
    dispose()
    return null
  }

  return {
    resize,
    frame: now => draw(START_SECONDS + (now - started) / 1000),
    still: () => draw(STILL_SECONDS),
    dispose,
  }
}

export function BurningFilm({className, running = true}: {className?: string; running?: boolean}) {
  const {host, canvas, failed} = useCanvasRenderer(createBurningFilm, RENDER_SCALE, running)
  if (failed) return null
  return (
    <div ref={host} aria-hidden className={className}>
      <canvas ref={canvas} className="block size-full" />
    </div>
  )
}
