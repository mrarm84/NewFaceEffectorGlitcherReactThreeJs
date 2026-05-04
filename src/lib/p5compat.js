// p5compat.js — Thin shim mapping the p5.js drawing API to native canvas2D.
// Pass the returned object as `p` to effect.apply(p, faceLMs, handLMs, poseLMs).
// PIXEL effects already use p.drawingContext directly — zero changes needed.
// DRAW effects use push/pop/stroke/fill/line/ellipse/circle — handled here.

export function makeP(ctx, width, height) {
  let _fillStyle   = '#ffffff';
  let _strokeStyle = '#000000';
  let _doFill      = true;
  let _doStroke    = true;
  let _lineWidth   = 1;
  const _stack = [];

  function _rgba(r, g, b, a = 255) {
    if (typeof r === 'string') return r;
    return `rgba(${r|0},${g|0},${b|0},${+(a / 255).toFixed(4)})`;
  }

  function _applyFill()   { ctx.fillStyle   = _doFill   ? _fillStyle   : 'rgba(0,0,0,0)'; }
  function _applyStroke() {
    ctx.strokeStyle = _doStroke ? _strokeStyle : 'rgba(0,0,0,0)';
    ctx.lineWidth   = _lineWidth;
  }

  const p = {
    width, height,
    get drawingContext() { return ctx; },

    background(r, g, b, a = 255) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (r !== undefined) {
        ctx.fillStyle = _rgba(r, g, b, a);
        ctx.fillRect(0, 0, width, height);
      } else {
        ctx.clearRect(0, 0, width, height);
      }
      ctx.restore();
    },

    push() {
      ctx.save();
      _stack.push({ _fillStyle, _strokeStyle, _doFill, _doStroke, _lineWidth });
    },
    pop() {
      ctx.restore();
      const s = _stack.pop();
      if (s) ({ _fillStyle, _strokeStyle, _doFill, _doStroke, _lineWidth } = s);
    },

    noFill()                    { _doFill = false; },
    noStroke()                  { _doStroke = false; },
    strokeCap(cap)              { ctx.lineCap = cap.toLowerCase(); },
    strokeJoin(join)            { ctx.lineJoin = join.toLowerCase(); },
    fill(r, g, b, a = 255)      {
      _doFill = true;
      if (r && typeof r === 'object') {
        _fillStyle = _rgba(r.r, r.g, r.b, r.a);
      } else {
        _fillStyle = _rgba(r, g, b, a);
      }
    },
    stroke(r, g, b, a = 255)    {
      _doStroke = true;
      if (r && typeof r === 'object') {
        _strokeStyle = _rgba(r.r, r.g, r.b, r.a);
      } else {
        _strokeStyle = _rgba(r, g, b, a);
      }
    },
    strokeWeight(w)             { _lineWidth = w; ctx.lineWidth = w; },

    translate(x, y) { ctx.translate(x, y); },
    scale(x, y = x) { ctx.scale(x, y); },
    rotate(a)       { ctx.rotate(a); },

    line(x1, y1, x2, y2) {
      _applyStroke();
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    },

    ellipse(x, y, w, h = w) {
      _applyFill(); _applyStroke();
      ctx.beginPath();
      ctx.ellipse(x, y, w / 2, h / 2, 0, 0, Math.PI * 2);
      if (_doFill)   ctx.fill();
      if (_doStroke) ctx.stroke();
    },

    circle(x, y, d) {
      _applyFill(); _applyStroke();
      ctx.beginPath();
      ctx.arc(x, y, d / 2, 0, Math.PI * 2);
      if (_doFill)   ctx.fill();
      if (_doStroke) ctx.stroke();
    },

    rect(x, y, w, h) {
      _applyFill(); _applyStroke();
      if (_doFill)   ctx.fillRect(x, y, w, h);
      if (_doStroke) ctx.strokeRect(x, y, w, h);
    },

    text(s, x, y) {
      _applyFill();
      ctx.fillText(String(s), x, y);
    },
    textSize(s) { ctx.font = `${s}px sans-serif`; },
    textAlign(h, v) {
      const hm = { LEFT: 'left', CENTER: 'center', RIGHT: 'right' };
      const vm = { TOP: 'top', CENTER: 'middle', BOTTOM: 'bottom', BASELINE: 'alphabetic' };
      ctx.textAlign = hm[h] ?? h ?? 'left';
      if (v !== undefined) ctx.textBaseline = vm[v] ?? v ?? 'alphabetic';
    },

    beginShape() { ctx.beginPath(); p._firstVertex = true; },
    vertex(x, y) { 
      if (p._firstVertex) {
        ctx.moveTo(x, y);
        p._firstVertex = false;
      } else {
        ctx.lineTo(x, y);
      }
    },
    endShape(close) {
      if (close === 'CLOSE' || close === p.CLOSE) ctx.closePath();
      _applyFill(); _applyStroke();
      if (_doFill)   ctx.fill();
      if (_doStroke) ctx.stroke();
    },

    map(n, a, b, c, d)   { return c + (d - c) * ((n - a) / (b - a)); },
    lerp(a, b, t)        { return a + (b - a) * t; },
    constrain(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); },
    dist(x1, y1, x2, y2) { return Math.hypot(x2 - x1, y2 - y1); },

    smooth() { ctx.imageSmoothingEnabled = true; },
    noSmooth() { ctx.imageSmoothingEnabled = false; },
    drawingContext: ctx,

    color(r, g, b, a = 255) {
      if (typeof r === 'string') {
        // Simple hex to rgb
        if (r.startsWith('#')) {
          const hex = r.slice(1);
          const big = parseInt(hex.length === 3 ? hex.split('').map(x=>x+x).join('') : hex, 16);
          return { r: (big >> 16) & 255, g: (big >> 8) & 255, b: big & 255, a };
        }
        return { r: 255, g: 255, b: 255, a, _str: r };
      }
      return { r, g, b, a };
    },

    lerpColor(c1, c2, t) {
      return {
        r: p.lerp(c1.r, c2.r, t),
        g: p.lerp(c1.g, c2.g, t),
        b: p.lerp(c1.b, c2.b, t),
        a: p.lerp(c1.a, c2.a, t)
      };
    },

    CENTER: 'CENTER', LEFT: 'LEFT', RIGHT: 'RIGHT',
    TOP: 'TOP', BOTTOM: 'BOTTOM', CLOSE: 'CLOSE',
    TWO_PI: Math.PI * 2,
  };

  return p;
}
