export const TRAIL_STYLES = Object.freeze(['pink', 'ribbon', 'stardust']);
export const TRAIL_LIMITS = Object.freeze({ lifetime: 600, points: 192, recentPoints: 96, defaultSmoothPoints: 256, smoothPoints: 512, paintSections: 64, sparks: 48, segmentSparks: 24 });
const validStyle = style => TRAIL_STYLES.includes(style);
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const lerp = (a, b, t) => a + (b - a) * t;
const styleOptions = Object.freeze({ pink: { spacing: 72, sparks: 12 }, ribbon: { spacing: 105, sparks: 10 }, stardust: { spacing: 22, sparks: 48 } });
const fadeAt = (at, now, lifetime = TRAIL_LIMITS.lifetime) => clamp(1 - (now - at) / lifetime, 0, 1);
const validDuration = value => Number.isFinite(value);
const durationSeconds = value => clamp(value, .1, 5);

// Keep a dense recent path plus a fixed-time archive. Unlike dropping the oldest
// point at a count limit, this retains the selected duration at any input rate.
function timedHistory(maximum, recentLimit, lifetime) {
  let archive = [], recent = [];
  const prune = now => {
    const alive = item => now - item.at < (item.life ?? lifetime());
    archive = archive.filter(alive); recent = recent.filter(alive);
  };
  return {
    push(item) {
      recent.push(item);
      if (recent.length <= recentLimit) return;
      const older = recent.shift(), capacity = maximum - recentLimit;
      if (!capacity) return;
      const bucket = lifetime() / capacity, previous = archive.at(-1);
      if (previous && Math.floor(previous.at / bucket) === Math.floor(older.at / bucket)) {
        archive[archive.length - 1] = { ...older, break: previous.break || older.break };
      } else archive.push(older);
      if (archive.length > capacity) archive.shift();
    },
    prune,
    last: () => recent.at(-1) ?? archive.at(-1),
    values(now) { prune(now); return [...archive, ...recent]; },
  };
}

/** Bounded, timestamped state shared by live drawing and deterministic tests. */
export function createTrailState({ random = Math.random } = {}) {
  let style = 'pink', duration = .6, generation = 0, sequence = -1, carry = 0, revision = 0, points, sparks;
  const reset = () => {
    points = timedHistory(TRAIL_LIMITS.points, TRAIL_LIMITS.recentPoints, () => duration * 1000);
    const count = styleOptions[style].sparks;
    sparks = timedHistory(count, duration <= .6 ? count : Math.max(2, Math.floor(count / 3)), () => duration * 1000);
    carry = 0; revision++;
  };
  reset();
  function acceptGeneration(value) {
    if (!Number.isSafeInteger(value) || value < generation) return false;
    if (value > generation) { generation = value; sequence = -1; reset(); }
    return true;
  }
  function clear(value) {
    if (value && !acceptGeneration(value.generation)) return false;
    reset(); return true;
  }
  function changeStyle(value) {
    if (!value || !validStyle(value.style) || !acceptGeneration(value.generation)) return false;
    if (validDuration(value.duration)) duration = durationSeconds(value.duration);
    style = value.style; reset(); return true;
  }
  function changeDuration(value) {
    if (!value || !validDuration(value.duration) || !acceptGeneration(value.generation)) return false;
    duration = durationSeconds(value.duration); reset(); return true;
  }
  function emitSparks(previous, point, now) {
    const length = Math.hypot(point.x - previous.x, point.y - previous.y), options = styleOptions[style];
    const count = Math.floor((carry + length) / options.spacing), first = options.spacing - carry;
    const emitted = Math.min(count, TRAIL_LIMITS.segmentSparks);
    for (let index = 0; index < emitted; index++) {
      // Very long fast segments spread the bounded budget across the whole path.
      const distance = count > emitted ? length * (index + .5) / emitted : first + index * options.spacing;
      const t = clamp(distance / Math.max(1, length), 0, 1), at = lerp(previous.at, point.at, t);
      const life = (420 + random() * 160) * duration / .6;
      if (now - at >= life) continue;
      const anchorX = lerp(previous.x, point.x, t), anchorY = lerp(previous.y, point.y, t);
      sparks.push({ x: anchorX + (random() - .5) * (style === 'stardust' ? 14 : 5),
        y: anchorY + (random() - .5) * (style === 'stardust' ? 14 : 5), anchorX, anchorY, at, life,
        size: style === 'stardust' ? .8 + random() * 1.9 : 1.1 + random() * .9,
        dx: (random() - .5) * 8, dy: -3 - random() * 6, variant: Math.floor(random() * 3) });
    }
    carry = (carry + length) % options.spacing;
  }
  function receive(packet, now, bounds) {
    if (!packet || !Number.isFinite(now) || !acceptGeneration(packet.generation)) return false;
    if (validDuration(packet.duration) && durationSeconds(packet.duration) !== duration) { duration = durationSeconds(packet.duration); reset(); }
    if (validStyle(packet.style) && packet.style !== style) { style = packet.style; reset(); }
    points.prune(now); sparks.prune(now);
    const batched = Array.isArray(packet.points);
    const incoming = batched ? packet.points.slice(-TRAIL_LIMITS.points) : [packet];
    let accepted = false;
    for (const value of incoming) {
      if (!value || !Number.isFinite(value.x) || !Number.isFinite(value.y) || !Number.isSafeInteger(value.sequence) || value.sequence <= sequence) continue;
      sequence = value.sequence;
      const age = Math.max(0, Number.isFinite(value.age) ? value.age : 0);
      let at = now - age;
      if (age >= duration * 1000 || value.x < 0 || value.y < 0 || value.x > bounds.width || value.y > bounds.height) continue;
      const previous = points.last();
      // Distance is deliberately unrestricted: a fast same-screen flick is a
      // continuous stroke. Batched samples already carry the host's actual
      // sampling boundaries; IPC delay must not create another break locally.
      // Retain gap detection only for the legacy single-point protocol.
      const disconnected = value.break === true || !previous || (!batched && at - previous.at > 180);
      // Batches can spend different amounts of time in IPC. Their local now-age
      // estimate may move backwards despite increasing host sequence numbers.
      // Genuine clock resets are already signalled by the host generation/break.
      if (!disconnected) at = Math.max(at, previous.at);
      const point = { x: value.x, y: value.y, at, break: disconnected };
      if (disconnected) carry = 0; else emitSparks(previous, point, now);
      points.push(point); accepted = true;
    }
    return accepted;
  }
  function frame(now) {
    return { style, duration, lifetime: duration * 1000, points: points.values(now), sparks: sparks.values(now).map(spark => ({ ...spark,
      x: spark.x + spark.dx * (now - spark.at) / spark.life,
      y: spark.y + spark.dy * (now - spark.at) / spark.life })) };
  }
  return { receive, clear, changeStyle, changeDuration, frame, get revision() { return revision; } };
}

function catmull(p0, p1, p2, p3, t, key) {
  const t2 = t * t, t3 = t2 * t;
  return .5 * ((2 * p1[key]) + (-p0[key] + p2[key]) * t
    + (2 * p0[key] - 5 * p1[key] + 4 * p2[key] - p3[key]) * t2
    + (-p0[key] + 3 * p1[key] - 3 * p2[key] + p3[key]) * t3);
}
/** Smooth centerlines share a global vertex budget, including very long flicks. */
export function smoothTrail(points, maximum = TRAIL_LIMITS.smoothPoints) {
  const chains = [];
  for (const point of points) {
    if (!chains.length || point.break) chains.push([]);
    chains.at(-1).push(point);
  }
  const spans = [];
  for (const chain of chains) for (let index = 1; index < chain.length; index++) {
    const length = Math.hypot(chain[index].x - chain[index - 1].x, chain[index].y - chain[index - 1].y);
    spans.push({ chain, index, length, desired: Math.max(1, Math.ceil(length / 10)) });
  }
  const desired = chains.length + spans.reduce((sum, span) => sum + span.desired, 0);
  const distance = spans.reduce((sum, span) => sum + span.length, 0), budget = Math.max(0, maximum - points.length);
  const steps = new Map(spans.map(span => [span.chain[span.index], desired <= maximum ? span.desired : 1 + Math.floor(span.length / Math.max(1, distance) * budget)]));
  return chains.map(chain => {
    const result = [chain[0]];
    for (let index = 1; index < chain.length; index++) {
      const before = chain[Math.max(0, index - 2)], previous = chain[index - 1], point = chain[index], after = chain[Math.min(chain.length - 1, index + 1)];
      const count = steps.get(point);
      for (let step = 1; step <= count; step++) {
        const t = step / count;
        result.push({ x: catmull(before, previous, point, after, t, 'x'), y: catmull(before, previous, point, after, t, 'y'), at: lerp(previous.at, point.at, t) });
      }
    }
    return result;
  });
}
export function trailBounds(chains, sparks) {
  const items = [...chains.flat(), ...sparks];
  if (!items.length) return null;
  const left = Math.min(...items.map(point => point.x)) - 30, top = Math.min(...items.map(point => point.y)) - 30;
  return { x: left, y: top, width: Math.max(...items.map(point => point.x)) - left + 30, height: Math.max(...items.map(point => point.y)) - top + 30 };
}
function centerPath(context, chain) {
  context.beginPath(); context.moveTo(chain[0].x, chain[0].y);
  for (const point of chain.slice(1)) context.lineTo(point.x, point.y);
}
function sectionPath(context, section) {
  const first = section.points[0];
  const next = section.points.find(point => Math.hypot(point.x - first.x, point.y - first.y) > .001);
  const length = next ? Math.hypot(next.x - first.x, next.y - first.y) : 1;
  // Butt edges otherwise each antialias their shared boundary to transparency.
  // Subpixel overlap closes that seam without the dark beads of round caps.
  const overlap = section.start > 0 && next ? .4 : 0;
  context.beginPath(); context.moveTo(first.x - (next?.x - first.x || 0) / length * overlap, first.y - (next?.y - first.y || 0) / length * overlap);
  for (const point of section.points.slice(1)) context.lineTo(point.x, point.y);
}
const chainLength = chain => chain.slice(1).reduce((sum, point, index) => sum + Math.hypot(point.x - chain[index].x, point.y - chain[index].y), 0);
const ribbonWidth = (progress, fade) => (.65 + 7.3 * progress ** .8) * fade ** .65;
export const ribbonColor = (progress, alpha = 1) => {
  const value = clamp(progress, 0, 1);
  return `rgba(${Math.round(lerp(255, 113, value))},${Math.round(lerp(57, 35, value))},${Math.round(lerp(150, 232, value))},${alpha})`;
};

/** Arc-length sections keep color tied to travel order, even when a path folds
 * back over itself. Strokes cannot cancel like a self-crossing fill.
 * Every frame has a fixed section budget; no segment uses a raster blur. */
export function paintSections(chains, maximum = TRAIL_LIMITS.paintSections) {
  if (chains.filter(chain => chain.length > 1).length > maximum) {
    const visible = chains.filter(chain => chain.length > 1);
    chains = Array.from({ length: maximum }, (_, index) => visible[Math.round(index * (visible.length - 1) / (maximum - 1))]);
  }
  const lengths = chains.map(chainLength), total = lengths.reduce((sum, length) => sum + length, 0);
  const visible = lengths.filter(length => length > 0).length, extra = Math.max(0, maximum - visible), result = [];
  for (let chainIndex = 0; chainIndex < chains.length; chainIndex++) {
    const chain = chains[chainIndex], length = lengths[chainIndex];
    if (!length) continue;
    const count = 1 + Math.min(31, Math.floor(length / total * extra), Math.max(0, Math.ceil(length / 18) - 1));
    let travelled = 0, sectionIndex = 0, section = { points: [chain[0]], start: 0, end: 0 };
    for (let index = 1; index < chain.length; index++) {
      const before = chain[index - 1], after = chain[index], distance = Math.hypot(after.x - before.x, after.y - before.y);
      const endDistance = travelled + distance;
      while (sectionIndex + 1 < count && (sectionIndex + 1) * length / count <= endDistance) {
        const boundary = (sectionIndex + 1) * length / count, t = clamp((boundary - travelled) / Math.max(.0001, distance), 0, 1);
        const point = { x: lerp(before.x, after.x, t), y: lerp(before.y, after.y, t), at: lerp(before.at, after.at, t) };
        section.points.push(point); section.end = ++sectionIndex / count; result.push(section);
        section = { points: [point], start: section.end, end: 1 };
      }
      section.points.push(after); travelled = endDistance;
    }
    section.end = 1; result.push(section);
  }
  return result;
}
function sectionFade(section, now, lifetime) {
  return fadeAt((section.points[0].at + section.points.at(-1).at) / 2, now, lifetime);
}
function drawPink(context, section, now, lifetime) {
  const fade = sectionFade(section, now, lifetime);
  sectionPath(context, section);
  context.strokeStyle = `rgba(242,135,191,${fade * .1})`; context.lineWidth = 5; context.stroke();
  context.strokeStyle = `rgba(246,139,196,${fade * .6})`; context.lineWidth = 1.1 + fade * 1.1; context.stroke();
  context.strokeStyle = `rgba(255,220,239,${fade * .7})`; context.lineWidth = .65; context.stroke();
}
export function ribbonGeometry(chain, now, lifetime = TRAIL_LIMITS.lifetime) {
  const left = [], right = [], widths = [], distances = [0];
  for (let index = 1; index < chain.length; index++) distances.push(distances.at(-1) + Math.hypot(chain[index].x - chain[index - 1].x, chain[index].y - chain[index - 1].y));
  for (let index = 0; index < chain.length; index++) {
    const point = chain[index], previous = chain[Math.max(0, index - 1)], next = chain[Math.min(chain.length - 1, index + 1)];
    const length = Math.hypot(next.x - previous.x, next.y - previous.y) || 1;
    const nx = -(next.y - previous.y) / length, ny = (next.x - previous.x) / length;
    const progress = distances[index] / Math.max(1, distances.at(-1));
    const width = ribbonWidth(progress, fadeAt(point.at, now, lifetime));
    widths.push(width); left.push({ x: point.x + nx * width / 2, y: point.y + ny * width / 2 });
    right.push({ x: point.x - nx * width / 2, y: point.y - ny * width / 2 });
  }
  return { left, right, widths };
}
function drawRibbon(context, section, now, lifetime) {
  const first = section.points[0], last = section.points.at(-1), progress = (section.start + section.end) / 2;
  const fade = sectionFade(section, now, lifetime), width = ribbonWidth(progress, fade);
  sectionPath(context, section);
  // A soft, unfiltered outer stroke avoids a full-screen blur surface during
  // fast zigzags. Butt section caps avoid double-alpha beads at color boundaries;
  // a continuous fine centerline underneath covers joins and exact reversals.
  context.strokeStyle = ribbonColor(progress, fade * .12); context.lineWidth = width + 3; context.stroke();
  let gradient = ribbonColor(progress, fade * .88);
  if (Math.hypot(last.x - first.x, last.y - first.y) > .1) {
    gradient = context.createLinearGradient(first.x, first.y, last.x, last.y);
    gradient.addColorStop(0, ribbonColor(section.start, fadeAt(first.at, now, lifetime) * .88));
    gradient.addColorStop(1, ribbonColor(section.end, fadeAt(last.at, now, lifetime) * .88));
  }
  context.strokeStyle = gradient; context.lineWidth = width; context.stroke();
}
function drawStardust(context, section, now, lifetime) {
  const fade = sectionFade(section, now, lifetime), progress = (section.start + section.end) / 2;
  centerPath(context, section.points); context.setLineDash([3, 11]);
  context.strokeStyle = `rgba(210,167,243,${fade * (.14 + progress * .28)})`; context.lineWidth = .85; context.stroke(); context.setLineDash([]);
}
function drawSparks(context, sparks, style, now) {
  for (const spark of sparks) {
    const age = clamp((now - spark.at) / spark.life, 0, 1), fade = (1 - age) ** 1.3, size = spark.size * (1 + age * .25);
    const colors = style === 'stardust' ? [[241,170,216], [184,153,242], [255,221,242]] : [[247,176,214], [220,166,238], [250,204,232]];
    const color = colors[spark.variant];
    context.beginPath(); context.arc(spark.x, spark.y, size * 2.5, 0, Math.PI * 2);
    context.fillStyle = `rgba(${color.join(',')},${fade * .09})`; context.fill();
    context.fillStyle = `rgba(${color.join(',')},${fade * (style === 'stardust' ? .9 : .5)})`;
    if (style === 'stardust' && spark.variant === 2) {
      context.beginPath(); context.arc(spark.x, spark.y, Math.max(.55, size * .5), 0, Math.PI * 2); context.fill();
    } else {
      context.beginPath(); context.moveTo(spark.x, spark.y - size * 1.5); context.lineTo(spark.x + size * .35, spark.y - size * .35);
      context.lineTo(spark.x + size * 1.5, spark.y); context.lineTo(spark.x + size * .35, spark.y + size * .35);
      context.lineTo(spark.x, spark.y + size * 1.5); context.lineTo(spark.x - size * .35, spark.y + size * .35);
      context.lineTo(spark.x - size * 1.5, spark.y); context.lineTo(spark.x - size * .35, spark.y - size * .35); context.closePath(); context.fill();
    }
  }
}
function followCurve(chains, sparks) {
  return sparks.map(spark => {
    if (!Number.isFinite(spark.anchorX) || !Number.isFinite(spark.anchorY)) return spark;
    let nearest = null, nearestDistance = Infinity;
    for (const chain of chains) {
      if (spark.at < chain[0].at || spark.at > chain.at(-1).at) continue;
      for (let index = 1; index < chain.length; index++) {
        const before = chain[index - 1], after = chain[index];
        const dx = after.x - before.x, dy = after.y - before.y;
        const t = clamp(((spark.anchorX - before.x) * dx + (spark.anchorY - before.y) * dy) / Math.max(.001, dx * dx + dy * dy), 0, 1);
        const x = lerp(before.x, after.x, t), y = lerp(before.y, after.y, t);
        const distance = (x - spark.anchorX) ** 2 + (y - spark.anchorY) ** 2;
        if (distance < nearestDistance) { nearestDistance = distance; nearest = { x, y }; }
      }
    }
    return nearest ? { ...spark, x: spark.x + nearest.x - spark.anchorX, y: spark.y + nearest.y - spark.anchorY } : spark;
  });
}
export function drawTrail(context, snapshot, now) {
  const lifetime = snapshot.lifetime ?? TRAIL_LIMITS.lifetime;
  const chains = smoothTrail(snapshot.points, lifetime === TRAIL_LIMITS.lifetime ? TRAIL_LIMITS.defaultSmoothPoints : TRAIL_LIMITS.smoothPoints);
  const sparks = followCurve(chains, snapshot.sparks);
  context.lineCap = 'round'; context.lineJoin = 'round'; context.shadowBlur = 0; context.setLineDash([]);
  if (snapshot.style !== 'stardust') for (const chain of chains) {
    if (chain.length < 2) continue;
    centerPath(context, chain); context.lineWidth = .65;
    const fade = fadeAt(chain.at(-1).at, now, lifetime);
    context.strokeStyle = snapshot.style === 'ribbon' ? ribbonColor(.5, fade * .22) : `rgba(246,139,196,${fade * .22})`; context.stroke();
  }
  context.lineCap = snapshot.style === 'stardust' ? 'round' : 'butt';
  for (const section of paintSections(chains)) {
    if (snapshot.style === 'ribbon') drawRibbon(context, section, now, lifetime);
    else if (snapshot.style === 'stardust') drawStardust(context, section, now, lifetime);
    else drawPink(context, section, now, lifetime);
  }
  context.lineCap = 'round';
  drawSparks(context, sparks, snapshot.style, now);
  const head = snapshot.points.at(-1);
  if (head) {
    const fade = fadeAt(head.at, now, lifetime), purple = snapshot.style === 'ribbon';
    context.beginPath(); context.arc(head.x, head.y, purple ? 6 : 4, 0, Math.PI * 2);
    context.fillStyle = purple ? `rgba(137,68,236,${fade * .13})` : `rgba(240,132,190,${fade * .12})`; context.fill();
    context.beginPath(); context.arc(head.x, head.y, purple ? 2.6 : 1.6, 0, Math.PI * 2);
    context.fillStyle = purple ? `rgba(137,68,236,${fade * .9})` : `rgba(255,215,237,${fade * .8})`; context.fill();
  }
  return trailBounds(chains, sparks);
}
