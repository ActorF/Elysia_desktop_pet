/** @fileoverview Joint-weighted character mesh: hair, fabric and legs swing as parts, never as a cursor-driven ripple. */
import { motionAmplitude, motionTime } from './motion-settings.mjs';
import { eyeWarpStrength } from './gaze-settings.mjs';
const W = 1090, H = 1443;
const IDLE_SWAY_SCALE = .55;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const smooth = (a, b, x) => { const v = clamp((x - a) / (b - a), 0, 1); return v * v * (3 - 2 * v); };

const PARTS = [
  { name: 'crown', pivot: [540, 180] },
  { name: 'left-lock', pivot: [330, 235], feather: 55, polygon: [[130,200],[370,220],[410,450],[405,632],[430,720],[332,790],[145,778],[100,600]] },
  { name: 'right-lock', pivot: [775, 210], feather: 55, polygon: [[665,235],[1015,230],[1075,675],[885,765],[660,710],[645,565],[670,390]] },
  { name: 'back-hair-right', pivot: [780, 724], polygon: [[827,699],[978,728],[1060,845],[1057,993],[931,1090],[823,1147],[777,1085],[898,1006],[936,902],[875,783]] },
  { name: 'back-hair-left', pivot: [294, 1128], polygon: [[223,1108],[305,1140],[300,1260],[408,1312],[412,1355],[299,1393],[156,1358],[157,1215]] },
  { name: 'cloak-left', pivot: [340, 859], feather: 40, polygon: [[307,859],[426,941],[419,1080],[371,1197],[439,1316],[390,1392],[262,1263],[65,1170],[47,1085],[160,967]] },
  { name: 'cloak-right', pivot: [755, 811], feather: 40, polygon: [[730,800],[845,815],[934,930],[896,1043],[882,1227],[765,1272],[703,1120],[678,950]] },
  { name: 'skirt', pivot: [537, 827], feather: 32, polygon: [[402,817],[672,815],[770,1012],[746,1095],[583,1098],[426,1114],[323,1061]] },
  // The polygons include the whole stocking and shoe, with room for a soft
  // outside margin. A mask ending at the shoe centre only bends a small patch.
  { name: 'leg-left', pivot: [454, 1063], feather: 38, polygon: [[388,1042],[526,1042],[595,1270],[619,1398],[474,1422],[414,1235]] },
  { name: 'leg-right', pivot: [564, 1066], feather: 38, polygon: [[510,1037],[654,1045],[726,1200],[753,1335],[653,1380],[536,1240]] },
  // Follow the pink fringe itself. The loose centre moves below a fixed root;
  // eye guards below keep the neighbouring lashes/skin out of this joint.
  { name: 'fringe', pivot: [500, 278], feather: 40, polygon: [[365,277],[575,241],[645,286],[650,420],[620,480],[541,517],[470,535],[420,510],[382,437],[363,373]] },
  { name: 'top-tuft', pivot: [832, 202], feather: 24, polygon: [[765,130],[856,113],[897,118],[941,111],[966,140],[950,204],[889,240],[799,226]] },
];

function polygonWeight(x, y, points, feather = 18) {
  let inside = false, distance = Infinity;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [ax, ay] = points[j], [bx, by] = points[i];
    if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
    const dx = bx - ax, dy = by - ay;
    const t = clamp(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy), 0, 1);
    distance = Math.min(distance, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return smooth(-feather, feather, inside ? distance : -distance);
}

// Keep the skin and complete eyelash silhouettes fixed, instead of freezing
// broad ellipses that also covered the visible front locks. The two tiny grey
// strokes printed across the fringe travel with that painted hair surface.
const FACE = [[320,513],[346,480],[377,455],[394,430],[418,473],[448,497],[477,497],[540,482],[572,460],[590,441],[607,401],[613,351],[614,310],[650,346],[680,401],[710,438],[731,483],[726,568],[711,614],[678,652],[604,682],[489,707],[374,663],[339,631],[324,582]];
const EAR = [[894,401],[991,401],[991,505],[894,525]];
const CAT_EARS = [
  [[159,292],[175,116],[205,48],[425,131],[335,211],[290,294]],
  [[665,132],[852,11],[902,80],[902,262],[835,294],[783,208]],
];
const PROP_ANCHORS = [
  [[0,430],[160,448],[345,553],[421,608],[445,842],[240,850],[185,790],[0,790]],
  [[480,590],[645,590],[755,750],[780,900],[510,900]],
  [[280,665],[495,665],[530,570],[650,570],[800,740],[805,940],[270,940]],
];
const outside = (x,y,polygon,margin=25) => 1-polygonWeight(x,y,polygon,margin);
function catAnchor(x,y) {
  return CAT_EARS.reduce((weight,polygon)=>weight*outside(x,y,polygon,38),1);
}

function propAnchors(x,y) {
  // Pad the foreground by a full mesh cell, then release nearby hair softly.
  return PROP_ANCHORS.map(polygon=>Math.max(0,(outside(x,y,polygon,120)-.7)/.3));
}
function weightsForPoint(x, y) {
  const weights = PARTS.map((part, index) => index === 0
    ? 1 - smooth(680, 765, y)
    : polygonWeight(x, y, part.polygon, part.feather));
  // Broad attachment transitions preserve shoulder/waist/hip continuity while
  // allowing the loose hems and complete shoes to travel visibly at pet size.
  weights[5] *= smooth(875, 975, y); weights[6] *= smooth(840, 950, y);
  weights[7] *= smooth(830, 940, y);
  weights[8] *= smooth(1060, 1150, y); weights[9] *= smooth(1060, 1150, y);
  const legs = weights[8] + weights[9];
  if (legs > 1) { weights[8] /= legs; weights[9] /= legs; }
  weights[1] *= smooth(210, 365, y);weights[2] *= smooth(215, 365, y);
  weights[10] *= smooth(290, 390, y);
  // Zero weight extends beyond the ear/face edges by a grid cell. The shader
  // interpolates only fixed vertices across these features; nearby hair has a
  // broad, smooth attachment transition with no frozen interior islands.
  const anchor=(polygon,margin)=>1-polygonWeight(x,y,polygon,margin);
  // Exact, padded core anchors (the soft field above is solely on the outside).
  const pin=(polygon,margin)=>Math.max(0,2*anchor(polygon,margin)-1);
  const fixed=pin(FACE,42)*pin(EAR,50);
  for(const index of [0,1,2,10,11])weights[index]*=fixed;
  return weights;
}

/** One slow idle cycle for hair, cloth and legs; the mouse never drives their movement. */
export function jointPose(time = 0, enabled = true, amplitude = 1) {
  if (!enabled) return new Float32Array(PARTS.length);
  const t = Number.isFinite(time) ? time : 0;
  const sway = Math.sin(t * .90) * IDLE_SWAY_SCALE * motionAmplitude({motionAmplitude:amplitude});
  // Share the same phase and direction so upper and lower parts turn together.
  // Retain each part's gentle arc size and the existing attachment geometry.
  // The crown and tuft sit above their pivots, so their rotations are reversed
  // to match the screen-space left/right travel of the hanging parts.
  return Float32Array.from([
    -.006, .047, .046, .044, .034, .050, .052, .050, .0655, .070, .105, -.035,
  ], amplitude => amplitude * sway);
}

// Blend the complete head into the neck; keep foreground props anchored.
const HEAD_ANGLE = .07, HEAD_X = 12, HEAD_Y = 20;
function headWeight(x, y, pose = 'idle') {
  const prop = ['megaphone','tea','cake'].indexOf(pose);
  // The source canvas has no spare pixels above cat ears or beside long hair.
  const edge = smooth(0, 80, y) * smooth(0, 80, x) * smooth(0, 80, W - x);
  return edge * (1 - smooth(630, 860, y)) * (prop < 0 ? 1 : propAnchors(x, y)[prop]);
}
export function headOffset(x, y, head = {}, pose = 'idle') {
  const gx = Number.isFinite(head.x) ? clamp(head.x, -1, 1) : 0;
  const gy = Number.isFinite(head.y) ? clamp(head.y, -1, 1) : 0;
  const angle = gx * HEAD_ANGLE, c = Math.cos(angle), s = Math.sin(angle);
  const qx = x - 540, qy = y - 720, weight = headWeight(x, y, pose);
  return [((c - 1) * qx - s * qy + gx * HEAD_X) * weight,
    (s * qx + (c - 1) * qy + gy * HEAD_Y) * weight];
}

/** Samples the same weighted transforms as the shader for screen-space motion audits. */
export function deformPoint(x, y, time = 0, enabled = true, cat = false, pose = 'idle', amplitude = 1, head = {}) {
  const angles = jointPose(time, enabled, amplitude), weights = weightsForPoint(x, y);
  let dx = 0, dy = 0;
  PARTS.forEach((part, i) => {
    const qx = x - part.pivot[0], qy = y - part.pivot[1];
    const c = Math.cos(angles[i]), s = Math.sin(angles[i]);
    dx += (c * qx - s * qy - qx) * weights[i];
    dy += (s * qx + c * qy - qy) * weights[i];
  });
  const index=['megaphone','tea','cake'].indexOf(pose);
  const attachment=(cat?Math.max(0,2*catAnchor(x,y)-1):1)*(index<0?1:propAnchors(x,y)[index]);
  const [hx, hy] = headOffset(x, y, head, pose);
  return [x + dx*attachment + hx, y + dy*attachment + hy];
}

const vertexSource = `
precision highp float;
attribute vec2 a_position;
attribute vec4 a_weights0;
attribute vec4 a_weights1;
attribute vec4 a_weights2;
attribute float a_catAnchor;
attribute vec3 a_propAnchors;
uniform vec3 u_joints[12];
uniform float u_cat;
uniform vec3 u_props;
uniform vec2 u_head;
varying vec2 v_uv;
vec2 rotated(vec2 p, vec3 joint) {
  vec2 q = p - joint.xy;
  float c = cos(joint.z), s = sin(joint.z);
  return vec2(c*q.x-s*q.y,s*q.x+c*q.y) + joint.xy - p;
}
void main() {
  vec2 p = a_position;
  vec2 delta = vec2(0.0);
  delta += rotated(p,u_joints[0])*a_weights0.x;
  delta += rotated(p,u_joints[1])*a_weights0.y;
  delta += rotated(p,u_joints[2])*a_weights0.z;
  delta += rotated(p,u_joints[3])*a_weights0.w;
  delta += rotated(p,u_joints[4])*a_weights1.x;
  delta += rotated(p,u_joints[5])*a_weights1.y;
  delta += rotated(p,u_joints[6])*a_weights1.z;
  delta += rotated(p,u_joints[7])*a_weights1.w;
  delta += rotated(p,u_joints[8])*a_weights2.x;
  delta += rotated(p,u_joints[9])*a_weights2.y;
  delta += rotated(p,u_joints[10])*a_weights2.z;
  delta += rotated(p,u_joints[11])*a_weights2.w;
  delta *= mix(1.0,a_catAnchor,u_cat)*(1.0-dot(u_props,vec3(1.0)-a_propAnchors));
  float edge = smoothstep(0.0,80.0,p.y)*smoothstep(0.0,80.0,p.x)*smoothstep(0.0,80.0,1090.0-p.x);
  float headWeight = edge*(1.0-smoothstep(630.0,860.0,p.y))*(1.0-dot(u_props,vec3(1.0)-a_propAnchors));
  vec2 q = p-vec2(540.0,720.0);
  float angle = u_head.x*${HEAD_ANGLE};
  float c = cos(angle), s = sin(angle);
  delta += (vec2((c-1.0)*q.x-s*q.y,s*q.x+(c-1.0)*q.y)+u_head*vec2(${HEAD_X}.0,${HEAD_Y}.0))*headWeight;
  v_uv = p / vec2(1090.0,1443.0);
  vec2 target = (p+delta)/vec2(1090.0,1443.0);
  gl_Position=vec4(target*vec2(2.0,-2.0)+vec2(-1.0,1.0),0.0,1.0);
}`;
const fragmentSource = `
precision highp float;
uniform sampler2D u_image;
uniform vec2 u_gaze;
uniform float u_gazeStrength;
varying vec2 v_uv;
void main() {
  vec2 p = v_uv*vec2(1090.0,1443.0);
  float l=1.0-smoothstep(0.15,1.0,length((p-vec2(413.0,556.0))/vec2(48.0,61.0)));
  float r=1.0-smoothstep(0.15,1.0,length((p-vec2(647.0,519.0))/vec2(57.0,66.0)));
  vec2 sampleUV=(p-u_gaze*vec2(7.0,5.0)*(l+r)*u_gazeStrength)/vec2(1090.0,1443.0);
  gl_FragColor=texture2D(u_image,sampleUV);
}`;

/** Creates a GPU mesh over a complete, already composed frame; expression pixels move with the same geometry. */
export function createMeshRig() {
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: true, preserveDrawingBuffer: true, depth: false });
  let available = false, previousSource = null, previousKey = null;
  let texture, program, gaze, gazeStrength, joints, catUniform, propsUniform, headUniform, count = 0;
  canvas.addEventListener('webglcontextlost', () => { available = false; });
  try {
    if (!gl) throw new Error('WebGL unavailable');
    const compile = (type, source) => {
      const shader = gl.createShader(type); gl.shaderSource(shader, source); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
      return shader;
    };
    program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexSource));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSource)); gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    const vertices = [], nx = 66, ny = 88;
    const add = (i, j) => {
      const x = W * i / nx, y = H * j / ny;
      const weights = weightsForPoint(x, y);
      vertices.push(x, y, ...weights, Math.max(0,2*catAnchor(x,y)-1),...propAnchors(x,y));
    };
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      add(i,j); add(i+1,j); add(i,j+1); add(i+1,j); add(i+1,j+1); add(i,j+1);
    }
    const stride = 6 + PARTS.length;
    count = vertices.length / stride;
    const buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);
    for (const [name, size, offset] of [['position',2,0],['weights0',4,2],['weights1',4,6],['weights2',4,10],['catAnchor',1,14],['propAnchors',3,15]]) {
      const attribute = gl.getAttribLocation(program, `a_${name}`);
      gl.enableVertexAttribArray(attribute); gl.vertexAttribPointer(attribute, size, gl.FLOAT, false, stride * 4, offset * 4);
    }
    texture = gl.createTexture(); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(gl.getUniformLocation(program,'u_image'), 0);
    catUniform=gl.getUniformLocation(program,'u_cat');propsUniform=gl.getUniformLocation(program,'u_props');
    headUniform = gl.getUniformLocation(program,'u_head');
    gaze = gl.getUniformLocation(program,'u_gaze'); gazeStrength = gl.getUniformLocation(program,'u_gazeStrength');
    joints = gl.getUniformLocation(program,'u_joints[0]');
    gl.viewport(0,0,W,H); gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.clearColor(0,0,0,0);
    available = true;
  } catch (error) { console.warn('Animation mesh unavailable:', error.message); }
  return {
    mode: 'mesh',
    get eyeTrackingAvailable() { return available; },
    get accelerated() { return available; },
    /** Deforms a cached expression drawing. Texture upload happens only when the expression image changes. */
    draw(source, key, state, settings, allowGaze = true) {
      if (!available || gl.isContextLost()) { available = false; return source; }
      const angles = jointPose(motionTime(state, settings), settings.hairMotion !== false, motionAmplitude(settings));
      const values = new Float32Array(PARTS.length * 3);
      PARTS.forEach((part, i) => values.set([...part.pivot, angles[i]], i * 3));
      if (previousSource !== source || previousKey !== key) {
        gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,source);
        previousSource = source; previousKey = key;
      }
      const track = allowGaze && settings.eyeTracking !== false;
      gl.uniform2f(gaze, track ? clamp(state.gaze.x,-1,1) : 0, track ? clamp(state.gaze.y,-1,1) : 0);
      gl.uniform1f(gazeStrength, eyeWarpStrength(settings));
      gl.uniform2f(headUniform, settings.headTracking === true ? clamp(state.head?.x ?? 0,-1,1) : 0, settings.headTracking === true ? clamp(state.head?.y ?? 0,-1,1) : 0);
      gl.uniform1f(catUniform,state.cat?1:0);
      const pose=state.pose??(state.megaphone?'megaphone':'idle');
      gl.uniform3f(propsUniform,pose==='megaphone'?1:0,pose==='tea'?1:0,pose==='cake'?1:0);
      gl.uniform3fv(joints,values); gl.clear(gl.COLOR_BUFFER_BIT); gl.drawArrays(gl.TRIANGLES,0,count);
      return canvas;
    },
  };
}

// Native hit testing needs the full motion range, not a recently drawn frame.
// These exports only describe the original mesh; they never alter its drawing.
export const MESH_GRID = Object.freeze({width: W, height: H, columns: 66, rows: 88});
const MAX_JOINT_ANGLES = [.006,.047,.046,.044,.034,.05,.052,.05,.0655,.07,.105,.035];

/** Conservative [minDx,minDy,maxDx,maxDy] over every joint phase at a vertex. */
export function meshPointMotionBounds(x, y, enabled = true, cat = false, pose = 'idle', amplitude = 1, headTracking = false) {
  const scale = IDLE_SWAY_SCALE * motionAmplitude({motionAmplitude:amplitude});
  const bounds = [0, 0, 0, 0];
  if (headTracking) {
    const qx = Math.abs(x - 540), qy = Math.abs(y - 720), weight = headWeight(x, y, pose);
    const dx = ((1 - Math.cos(HEAD_ANGLE)) * qx + Math.sin(HEAD_ANGLE) * qy + HEAD_X) * weight;
    const dy = (Math.sin(HEAD_ANGLE) * qx + (1 - Math.cos(HEAD_ANGLE)) * qy + HEAD_Y) * weight;
    bounds.splice(0, 4, -dx, -dy, dx, dy);
  }
  if (!enabled || !scale) return bounds;
  const weights = weightsForPoint(x, y);
  const prop = ['megaphone','tea','cake'].indexOf(pose);
  const attachment = (cat ? Math.max(0, 2 * catAnchor(x, y) - 1) : 1)
    * (prop < 0 ? 1 : propAnchors(x, y)[prop]);
  for (let i = 0; i < PARTS.length; i++) {
    const weight = weights[i] * attachment;
    if (!weight) continue;
    const qx = x - PARTS[i].pivot[0], qy = y - PARTS[i].pivot[1];
    // Uniform angles are Float32: round the maxima outward before bounding.
    const maxAngle = MAX_JOINT_ANGLES[i] * scale;
    const a = Math.max(maxAngle, Math.fround(maxAngle));
    for (let axis = 0; axis < 2; axis++) {
      const value = angle => axis === 0
        ? (Math.cos(angle) - 1) * qx - Math.sin(angle) * qy
        : Math.sin(angle) * qx + (Math.cos(angle) - 1) * qy;
      let low = Math.min(0, value(-a), value(a)), high = Math.max(0, value(-a), value(a));
      const critical = axis === 0 ? Math.atan2(-qy, qx) : Math.atan2(qx, qy);
      for (let turn = -2; turn <= 2; turn++) {
        const angle = critical + turn * Math.PI;
        if (angle > -a && angle < a) {
          const v = value(angle); low = Math.min(low, v); high = Math.max(high, v);
        }
      }
      bounds[axis] += low * weight;
      bounds[axis + 2] += high * weight;
    }
  }
  return bounds;
}
