/* ==========================================================================
   ink.js — a brush that bleeds.

   A stroke is laid down in three passes:
     1. the core    — soft nib stamps interpolated along the path, width
                      driven by speed and stylus pressure
     2. the wick    — low-alpha satellites thrown sideways off each stamp,
                      which accumulate into a feathered wet edge
     3. the settle  — after you lift, expanding halos are deposited along
                      the path over ~0.9s, so the ink visibly spreads and dries

   Nibs are pre-rendered into a sprite cache and blitted, rather than
   building a radial gradient per stamp — a fast stroke is several hundred
   stamps and gradients would drop frames.
   ========================================================================== */

window.Ink = (function () {
  "use strict";

  var TAU = Math.PI * 2;

  var CFG = {
    dprCap: 1.5, // ink doesn't need retina; caps memory across 10 pages
    baseRadius: 1.95, // CSS px, half-width of the nib at rest
    minFactor: 0.34, // thinnest the nib gets when moving fast
    maxSpeed: 2.4, // px/ms at which that floor is reached
    smooth: 0.62, // radius inertia between samples
    coreAlpha: 0.62, // the line itself wants to be crisp and dark...
    wickAlpha: 0.017, // ...and everything around it barely there
    wickSpread: 1.75, // satellite radius, as a multiple of core radius
    settleMs: 9,
    settleWaves: 10,
    settleAlpha: 0.007,
    settleSpread: 1.85,
    tendrilMin: 2,
    tendrilMax: 9,
    undoDepth: 6,
    storePrefix: "cv-ink:",
  };

  var dpr = Math.min(window.devicePixelRatio || 1, CFG.dprCap);
  var colour = [20, 20, 20];
  var enabled = false;
  var canStore = true;
  var sheets = new Map(); // face element -> Sheet
  var nibCache = new Map();
  var lastTouched = null;

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function rgba(c, a) {
    return "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + a + ")";
  }

  // surfaces name themselves with data-ink-key; page faces derive one from
  // their leaf. The key is also the exported filename: ink-<key>.png
  function shortKey(el) {
    if (el.dataset && el.dataset.inkKey) return el.dataset.inkKey;
    var leaf = el.closest(".leaf");
    var side = el.classList.contains("face--front") ? "r" : "v";
    return (leaf ? leaf.dataset.leaf : "x") + side;
  }

  function keyFor(el) {
    return CFG.storePrefix + shortKey(el);
  }

  /* ---- nib sprites ------------------------------------------------------ */

  function nib(radius) {
    var r = Math.max(1, Math.round(radius));
    var key = colour.join(",") + "|" + r;
    var sprite = nibCache.get(key);
    if (sprite) return sprite;

    var size = r * 2;
    sprite = document.createElement("canvas");
    sprite.width = size;
    sprite.height = size;
    var c = sprite.getContext("2d");
    var g = c.createRadialGradient(r, r, 0, r, r, r);
    // solid core, falloff only in the last fifth — a pen line, not an airbrush
    g.addColorStop(0, rgba(colour, 1));
    g.addColorStop(0.72, rgba(colour, 0.98));
    g.addColorStop(0.9, rgba(colour, 0.5));
    g.addColorStop(1, rgba(colour, 0));
    c.fillStyle = g;
    c.fillRect(0, 0, size, size);

    // the cache is per-colour; keep it from growing without bound
    if (nibCache.size > 160) nibCache.clear();
    nibCache.set(key, sprite);
    return sprite;
  }

  /* ---- a single drawable page face -------------------------------------- */

  function Sheet(face) {
    this.face = face;
    this.dirty = false;
    this.undo = [];
    this.stroke = null;
    this.settleId = 0;

    var cv = document.createElement("canvas");
    cv.className = "ink-layer";
    this.canvas = cv;
    this.ctx = cv.getContext("2d");
    face.appendChild(cv);

    this.sync();
    this.bind();
  }

  // match the backing store to the face's layout size, preserving any ink
  Sheet.prototype.sync = function () {
    var w = this.face.offsetWidth;
    var h = this.face.offsetHeight;
    if (!w || !h) return;

    var bw = Math.round(w * dpr);
    var bh = Math.round(h * dpr);
    if (this.canvas.width === bw && this.canvas.height === bh) return;

    var old = null;
    if (this.canvas.width && this.canvas.height) {
      old = document.createElement("canvas");
      old.width = this.canvas.width;
      old.height = this.canvas.height;
      old.getContext("2d").drawImage(this.canvas, 0, 0);
    }

    this.canvas.width = bw;
    this.canvas.height = bh;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (old) this.ctx.drawImage(old, 0, 0, w, h);
  };

  Sheet.prototype.point = function (ev) {
    var r = this.canvas.getBoundingClientRect();
    var sx = r.width ? this.face.offsetWidth / r.width : 1;
    var sy = r.height ? this.face.offsetHeight / r.height : 1;
    var press = ev.pressure > 0 && ev.pressure < 1 ? ev.pressure : 0.5;
    return {
      x: (ev.clientX - r.left) * sx,
      y: (ev.clientY - r.top) * sy,
      p: press,
      t: ev.timeStamp || performance.now(),
    };
  };

  Sheet.prototype.bind = function () {
    var self = this;

    this.canvas.addEventListener("pointerdown", function (e) {
      if (!enabled || e.button !== 0) return;
      e.preventDefault();
      self.canvas.setPointerCapture(e.pointerId);
      lastTouched = self;
      self.begin(self.point(e));
    });

    this.canvas.addEventListener("pointermove", function (e) {
      if (!self.stroke) return;
      e.preventDefault();
      var batch = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (var i = 0; i < batch.length; i++) self.extend(self.point(batch[i]));
    });

    function finish(e) {
      if (!self.stroke) return;
      try {
        self.canvas.releasePointerCapture(e.pointerId);
      } catch (_) {
        /* pointer already gone */
      }
      self.end();
    }

    this.canvas.addEventListener("pointerup", finish);
    this.canvas.addEventListener("pointercancel", finish);
  };

  /* ---- stroke ----------------------------------------------------------- */

  Sheet.prototype.begin = function (pt) {
    this.snapshot();
    pt.r = CFG.baseRadius * (0.55 + 0.9 * pt.p);
    this.stroke = [pt];
    this.dirty = true;
    this.blot(pt.x, pt.y, pt.r, CFG.coreAlpha);
  };

  Sheet.prototype.extend = function (pt) {
    var prev = this.stroke[this.stroke.length - 1];
    var dx = pt.x - prev.x;
    var dy = pt.y - prev.y;
    var dist = Math.hypot(dx, dy);
    if (dist < 0.35) return;

    var dt = Math.max(pt.t - prev.t, 1);
    var speed = dist / dt;
    var thin = clamp(1 - speed / CFG.maxSpeed, CFG.minFactor, 1);
    var target = CFG.baseRadius * (0.55 + 0.9 * pt.p) * thin;
    pt.r = prev.r * CFG.smooth + target * (1 - CFG.smooth);

    var angle = Math.atan2(dy, dx);
    var step = Math.max(pt.r * 0.34, 0.55);

    for (var d = 0; d < dist; d += step) {
      var k = d / dist;
      var x = prev.x + dx * k;
      var y = prev.y + dy * k;
      var r = prev.r + (pt.r - prev.r) * k;

      this.blot(x, y, r, CFG.coreAlpha);

      // wick sideways into the fibres
      var n = 2 + ((Math.random() * 3) | 0);
      for (var i = 0; i < n; i++) {
        var side = Math.random() < 0.5 ? 1 : -1;
        var a = angle + side * (Math.PI / 2) + (Math.random() - 0.5) * 1.2;
        var off = r * (0.25 + Math.random() * 0.85);
        this.blot(
          x + Math.cos(a) * off,
          y + Math.sin(a) * off,
          r * (1.3 + Math.random() * (CFG.wickSpread - 1.3)),
          CFG.wickAlpha
        );
      }

      // pooling: slow strokes deposit more ink in the same place
      if (speed < 0.25) this.blot(x, y, r * 1.12, CFG.coreAlpha * 0.5);
    }

    this.stroke.push(pt);
  };

  Sheet.prototype.end = function () {
    var pts = this.stroke;
    this.stroke = null;
    if (!pts || !pts.length) return;

    this.tendrils(pts);
    this.settle(pts);
  };

  Sheet.prototype.blot = function (x, y, r, alpha) {
    var sprite = nib(r);
    var half = sprite.width / 2;
    this.ctx.globalAlpha = alpha;
    this.ctx.drawImage(sprite, x - half, y - half, sprite.width, sprite.width);
    this.ctx.globalAlpha = 1;
  };

  // capillary threads crawling out of the wet edge along the paper fibres
  Sheet.prototype.tendrils = function (pts) {
    var count = clamp(
      Math.round(pts.length / 12),
      CFG.tendrilMin,
      CFG.tendrilMax
    );

    for (var i = 0; i < count; i++) {
      var seed = pts[(Math.random() * pts.length) | 0];
      var a = Math.random() * TAU;
      var x = seed.x;
      var y = seed.y;
      var r = seed.r * (0.3 + Math.random() * 0.22);
      var steps = 4 + ((Math.random() * 8) | 0);

      for (var s = 0; s < steps; s++) {
        a += (Math.random() - 0.5) * 0.9;
        var len = seed.r * (0.55 + Math.random() * 1.1);
        x += Math.cos(a) * len;
        y += Math.sin(a) * len;
        r *= 0.78;
        if (r < 0.35) break;
        this.blot(x, y, r, 0.13 * (1 - s / steps));
      }
    }
  };

  // the wet spread, deposited in discrete waves so it can't over-darken
  Sheet.prototype.settle = function (pts) {
    var self = this;
    var id = ++this.settleId;
    var start = performance.now();
    var done = 0;

    // sample the path — every point would be far more work than it's worth
    var sampled = [];
    var stride = Math.max(1, Math.round(pts.length / 90));
    for (var i = 0; i < pts.length; i += stride) sampled.push(pts[i]);

    function frame(now) {
      if (id !== self.settleId) return; // a newer stroke took over
      var k = clamp((now - start) / CFG.settleMs, 0, 1);
      var want = Math.floor(k * CFG.settleWaves);

      while (done < want) {
        done++;
        var t = done / CFG.settleWaves;
        var spread = 1.15 + t * (CFG.settleSpread - 1.15);
        var alpha = CFG.settleAlpha * (1 - t * 0.75);

        for (var j = 0; j < sampled.length; j++) {
          var p = sampled[j];
          var jitter = p.r * 0.5;
          self.blot(
            p.x + (Math.random() - 0.5) * jitter,
            p.y + (Math.random() - 0.5) * jitter,
            p.r * spread * (0.85 + Math.random() * 0.3),
            alpha
          );
        }
      }

      if (k < 1) requestAnimationFrame(frame);
      else self.persist();
    }

    requestAnimationFrame(frame);
  };

  /* ---- undo / clear / storage ------------------------------------------- */

  Sheet.prototype.snapshot = function () {
    if (!this.canvas.width) return;
    var copy = document.createElement("canvas");
    copy.width = this.canvas.width;
    copy.height = this.canvas.height;
    copy.getContext("2d").drawImage(this.canvas, 0, 0);
    this.undo.push(copy);
    if (this.undo.length > CFG.undoDepth) this.undo.shift();
  };

  Sheet.prototype.stepBack = function () {
    var prev = this.undo.pop();
    this.settleId++; // abandon any in-flight settle
    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (prev) this.ctx.drawImage(prev, 0, 0);
    this.ctx.restore();
    // stays dirty: the undo stack is capped, so an empty stack does not
    // mean the sheet is back to pristine
    this.persist();
  };

  Sheet.prototype.wipe = function () {
    this.snapshot();
    this.settleId++;
    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.restore();
    this.dirty = false;
    this.persist();
  };

  Sheet.prototype.persist = function () {
    if (!canStore) return;
    var key = keyFor(this.face);
    try {
      if (!this.dirty) {
        localStorage.removeItem(key);
        return;
      }
      localStorage.setItem(key, this.canvas.toDataURL("image/webp", 0.7));
    } catch (_) {
      // quota, private mode, whatever — drawing still works, it just
      // won't survive a reload
      canStore = false;
    }
  };

  Sheet.prototype.restore = function (data) {
    var self = this;
    var img = new Image();
    img.onload = function () {
      self.sync();
      self.ctx.drawImage(img, 0, 0, self.face.offsetWidth, self.face.offsetHeight);
      self.dirty = true;
    };
    img.src = data;
  };

  /* ---- public ----------------------------------------------------------- */

  function sheetFor(face) {
    var s = sheets.get(face);
    if (!s) {
      s = new Sheet(face);
      sheets.set(face, s);
    }
    return s;
  }

  // drop a committed PNG onto a surface, printed for every visitor.
  // shiftY nudges it down the page by a percentage, for when a drawing
  // landed on top of something that needs to stay readable.
  function bake(el, key, shiftY) {
    var img = document.createElement("img");
    img.className = "baked-ink";
    img.alt = "";
    img.setAttribute("aria-hidden", "true");
    if (shiftY) img.style.transform = "translateY(" + shiftY + "%)";
    img.src = "images/ink-" + key + ".png";
    el.appendChild(img);
  }

  // prefer the sheet the pen was last on, else whichever visible one has ink
  function pickTarget(faces) {
    if (
      lastTouched &&
      lastTouched.undo.length &&
      faces.indexOf(lastTouched.face) !== -1
    ) {
      return lastTouched;
    }
    for (var i = faces.length - 1; i >= 0; i--) {
      var s = sheets.get(faces[i]);
      if (s && s.undo.length) return s;
    }
    return null;
  }

  return {
    // restore anything drawn in a previous visit
    init: function (faces) {
      if (!canStore) return;
      faces.forEach(function (face) {
        var data;
        try {
          // a page whose drawing has been committed ignores the local copy
          // of that same drawing — otherwise the two stack and print double
          if (face.querySelector(".baked-ink")) {
            localStorage.removeItem(keyFor(face));
            return;
          }
          data = localStorage.getItem(keyFor(face));
        } catch (_) {
          canStore = false;
          return;
        }
        if (data) sheetFor(face).restore(data);
      });
    },

    setEnabled: function (on) {
      enabled = on;
      document.body.classList.toggle("is-drawing", on);
    },

    // print committed artwork onto the listed surfaces
    bakeAll: function (items, resolve) {
      items.forEach(function (item) {
        var el = resolve(item.key);
        if (el) bake(el, item.key, item.y);
      });
    },

    setColour: function (rgb) {
      colour = rgb;
      nibCache.clear();
    },

    // called on every page turn: give the visible faces a canvas, and take
    // it back from clean off-screen ones so memory stays bounded
    setVisible: function (faces) {
      if (enabled) {
        faces.forEach(function (f) {
          sheetFor(f);
        });
      }
      sheets.forEach(function (sheet, face) {
        if (faces.indexOf(face) === -1 && !sheet.dirty) {
          sheet.canvas.remove();
          sheets.delete(face);
        }
      });
    },

    undo: function (faces) {
      var target = pickTarget(faces);
      if (target) target.stepBack();
    },

    clear: function (faces) {
      faces.forEach(function (face) {
        var s = sheets.get(face);
        if (s) s.wipe();
      });
    },

    // Ctrl+S: save every surface that has ink on it as a transparent PNG.
    // localStorage only keeps a drawing on the machine that made it, so this
    // is how a drawing gets out of the browser and into the repo.
    download: function () {
      var n = 0;
      sheets.forEach(function (s) {
        if (!s.dirty) return;
        var a = document.createElement("a");
        a.href = s.canvas.toDataURL("image/png");
        a.download = "ink-" + shortKey(s.face) + ".png";
        a.click();
        n++;
      });
      return n;
    },

    relayout: function () {
      sheets.forEach(function (s) {
        s.sync();
      });
    },
  };

  // prefer the sheet the user actually drew on, else whichever visible one has ink
  function pickTarget(faces) {
    if (lastTouched && faces.indexOf(lastTouched.face) !== -1 && lastTouched.undo.length) {
      return lastTouched;
    }
    for (var i = faces.length - 1; i >= 0; i--) {
      var s = sheets.get(faces[i]);
      if (s && s.undo.length) return s;
    }
    return null;
  }
})();
