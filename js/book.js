/* ==========================================================================
   book.js — turning the pages.

   Desktop is a two-page spread: leaves are hinged at the spine and rotate
   -180deg about their left edge. The only fiddly part is z-order — a leaf
   mid-turn has to ride above both stacks, and on landing it has to drop onto
   the correct one, so the stack is re-sorted after every turn.

   The book stops one leaf short of the end, so it always closes on the
   Contact / blank-sheet spread and the rear board is never reached.

   Under 880px there is no room for a spread, so the same faces are shown
   one at a time with a 2D slide.
   ========================================================================== */

(function () {
  "use strict";

  var book = document.getElementById("book");
  if (!book) return;

  var leaves = Array.prototype.slice.call(book.querySelectorAll(".leaf"));
  var total = leaves.length;

  // reading order: cover, contents, page 1, page 2, ...
  var faces = [];
  leaves.forEach(function (leaf) {
    faces.push(leaf.querySelector(".face--front"));
    faces.push(leaf.querySelector(".face--back"));
  });

  var MAX_SPREAD = total - 1; // the rear board is never turned to
  var MAX_FACE = faces.length - 2; // ...and never shown on its own either

  /* ------------------------------------------------------------------------
     Committed artwork.

     Pick up the pen, draw on a page, then press Ctrl+S — every page with ink
     on it downloads as ink-<key>.png. Drop those files into images/ and add
     their keys here, and they print for every visitor.

       key  "<n>r" the front of leaf n, "<n>v" the back — as exported
       y    optional, nudges the drawing down the page by a percentage
     ---------------------------------------------------------------------- */
  var BAKED = [
    { key: "0v", y: 6 }, // "yo! — david" — nudged clear of the email address
    { key: "1v" }, // chasing the bag, under the MIT entry
    { key: "4r" }, // the face, on the blank sheet at the end
  ];

  var DUR =
    parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--flip")
    ) || 950;
  var STAGGER = Math.min(150, DUR * 0.16);
  var SLIDE = 460;

  // spread anchors, by number of leaves turned
  var ANCHORS = {
    contents: 1,
    education: 1,
    skills: 1,
    experience: 2,
    projects: 3,
    contact: 4,
    drawing: 4,
  };

  var current = 0; // leaves turned (desktop)
  var faceIndex = 0; // face shown (single-page)
  var single = false;
  var busy = false;

  var narrow = window.matchMedia("(max-width: 880px)");

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  /* ---- what is on screen right now -------------------------------------- */

  function visibleFaces() {
    if (single) return [faces[faceIndex]];
    var out = [];
    if (current > 0) out.push(leaves[current - 1].querySelector(".face--back"));
    if (current < total)
      out.push(leaves[current].querySelector(".face--front"));
    return out;
  }

  function updateAccess() {
    var vis = visibleFaces();
    faces.forEach(function (face) {
      var hidden = vis.indexOf(face) === -1;
      face.inert = hidden;
      face.setAttribute("aria-hidden", hidden ? "true" : "false");
    });

    // a corner that would run off either end of the book is not a control
    var atStart = single ? faceIndex === 0 : current === 0;
    var atEnd = single ? faceIndex === MAX_FACE : current === MAX_SPREAD;
    vis.forEach(function (face) {
      face.querySelectorAll(".corner").forEach(function (c) {
        var fwd = c.dataset.turn === "next";
        c.disabled = fwd ? atEnd : atStart;
        c.style.display = c.disabled ? "none" : "";
      });
    });
  }

  function afterMove() {
    updateAccess();
    window.Ink.setVisible(visibleFaces());
  }

  /* ---- desktop: hinged leaves ------------------------------------------- */

  function restack() {
    leaves.forEach(function (leaf, i) {
      // turned leaves pile up to the left, untouched ones to the right
      leaf.style.zIndex = i < current ? i + 1 : total - i;
    });
  }

  function syncBook() {
    book.style.setProperty("--turned", current);
  }

  function turnOne(dir) {
    var i = dir > 0 ? current : current - 1;
    var leaf = leaves[i];
    if (!leaf) return;

    current += dir;

    // ride above both stacks for the duration of the turn; the +i keeps
    // concurrently-turning leaves in the right order during a multi-page jump
    leaf.style.zIndex = total + 2 + i;
    leaf.classList.add("is-turning");
    leaf.classList.toggle("is-flipped", dir > 0);

    syncBook();

    clearTimeout(leaf._settle);
    leaf._settle = setTimeout(function () {
      leaf.classList.remove("is-turning");
      restack();
    }, DUR);
  }

  function goTo(target, instant) {
    target = clamp(target, 0, MAX_SPREAD);
    if (single) return goToFace(target === 0 ? 0 : target * 2 - 1, instant);
    if (busy || target === current) return;

    if (instant) {
      current = target;
      leaves.forEach(function (leaf, i) {
        leaf.classList.toggle("is-flipped", i < current);
      });
      syncBook();
      restack();
      afterMove();
      return;
    }

    var dir = target > current ? 1 : -1;
    var steps = Math.abs(target - current);
    var fired = 0;
    busy = true;

    (function fire() {
      turnOne(dir);
      fired++;
      afterMove();
      if (fired < steps) setTimeout(fire, STAGGER);
      else
        setTimeout(function () {
          busy = false;
        }, DUR);
    })();
  }

  /* ---- narrow: one face at a time --------------------------------------- */

  function goToFace(target, instant) {
    target = clamp(target, 0, MAX_FACE);
    if (busy || target === faceIndex) return;

    var out = faces[faceIndex];
    var into = faces[target];
    var forward = target > faceIndex;
    faceIndex = target;

    faces.forEach(function (f) {
      f.classList.remove("is-current", "is-leaving", "is-leaving-back");
    });
    into.classList.add("is-current");

    if (!instant) {
      busy = true;
      out.classList.add(forward ? "is-leaving" : "is-leaving-back");
      setTimeout(function () {
        out.classList.remove("is-leaving", "is-leaving-back");
        busy = false;
      }, SLIDE);
    }

    afterMove();
  }

  /* ---- shared navigation ------------------------------------------------ */

  function next() {
    single ? goToFace(faceIndex + 1) : goTo(current + 1);
  }

  function prev() {
    single ? goToFace(faceIndex - 1) : goTo(current - 1);
  }

  /* ---- mode switching --------------------------------------------------- */

  function setMode(isSingle) {
    if (isSingle === single) return;

    if (isSingle) {
      // a spread maps to its left-hand page, except the closed cover
      faceIndex = clamp(current === 0 ? 0 : current * 2 - 1, 0, MAX_FACE);
      document.body.classList.add("is-single");
      faces.forEach(function (f, i) {
        f.classList.toggle("is-current", i === faceIndex);
      });
    } else {
      current = clamp(
        faceIndex === 0 ? 0 : Math.ceil(faceIndex / 2),
        0,
        MAX_SPREAD
      );
      document.body.classList.remove("is-single");
      faces.forEach(function (f) {
        f.classList.remove("is-current", "is-leaving", "is-leaving-back");
      });
      leaves.forEach(function (leaf, i) {
        leaf.classList.toggle("is-flipped", i < current);
      });
      syncBook();
      restack();
    }

    single = isSingle;
    updateAccess();
    window.Ink.setVisible(visibleFaces());
    window.Ink.relayout();
  }

  /* ---- wiring ----------------------------------------------------------- */

  // every face needs both corners in single-page mode; on the spread the
  // irrelevant one is hidden by CSS
  faces.forEach(function (face) {
    if (!face.querySelector(".corner--fwd")) face.appendChild(makeCorner("next"));
    if (!face.querySelector(".corner--back")) face.appendChild(makeCorner("prev"));
  });

  function makeCorner(dir) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "corner " + (dir === "next" ? "corner--fwd" : "corner--back");
    b.dataset.turn = dir;
    b.innerHTML =
      '<span class="sr-only">' +
      (dir === "next" ? "Next page" : "Previous page") +
      "</span>";
    return b;
  }

  book.addEventListener("click", function (e) {
    var corner = e.target.closest("[data-turn]");
    if (corner) {
      corner.dataset.turn === "next" ? next() : prev();
      return;
    }
    var jump = e.target.closest("[data-goto]");
    if (jump) goTo(parseInt(jump.dataset.goto, 10));
  });

  document.addEventListener("keydown", function (e) {
    var t = e.target;
    var typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA");

    if (e.ctrlKey || e.metaKey) {
      if (e.key === "z" || e.key === "Z") {
        e.preventDefault();
        window.Ink.undo(visibleFaces());
      } else if (e.key === "s" || e.key === "S") {
        // export every inked surface as a transparent PNG
        e.preventDefault();
        window.Ink.download();
      }
      return;
    }

    if (typing) return;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      next();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      prev();
    }
  });

  // swipe — but not while the pen is out, those gestures are strokes
  var swipe = null;
  book.addEventListener("pointerdown", function (e) {
    if (document.body.classList.contains("is-drawing")) return;
    swipe = { x: e.clientX, y: e.clientY };
  });
  book.addEventListener("pointerup", function (e) {
    if (!swipe) return;
    var dx = e.clientX - swipe.x;
    var dy = e.clientY - swipe.y;
    swipe = null;
    if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.6) {
      dx < 0 ? next() : prev();
    }
  });

  var resizeT;
  window.addEventListener("resize", function () {
    clearTimeout(resizeT);
    resizeT = setTimeout(function () {
      setMode(narrow.matches);
      window.Ink.relayout();
    }, 140);
  });

  /* ---- the pen ---------------------------------------------------------- */

  var penBtn = document.getElementById("pen-toggle");
  penBtn.addEventListener("click", function () {
    var on = penBtn.getAttribute("aria-pressed") !== "true";
    penBtn.setAttribute("aria-pressed", String(on));
    window.Ink.setEnabled(on);
    if (on) window.Ink.setVisible(visibleFaces());
  });

  /* ---- contact form ----------------------------------------------------- */

  var form = document.getElementById("contact-form");
  var note = document.getElementById("form-note");
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    note.textContent =
      "This form is a demo and doesn't send mail — reach me at duzor144@gmail.com.";
  });

  /* ---- start ------------------------------------------------------------ */

  single = narrow.matches;
  if (single) document.body.classList.add("is-single");

  var hash = (location.hash || "").replace("#", "");
  var start = Object.prototype.hasOwnProperty.call(ANCHORS, hash)
    ? ANCHORS[hash]
    : 0;

  if (single) {
    faceIndex = clamp(start === 0 ? 0 : start * 2 - 1, 0, MAX_FACE);
    faces.forEach(function (f, i) {
      f.classList.toggle("is-current", i === faceIndex);
    });
  } else {
    current = clamp(start, 0, MAX_SPREAD);
    leaves.forEach(function (leaf, i) {
      leaf.classList.toggle("is-flipped", i < current);
    });
  }

  syncBook();
  restack();
  updateAccess();

  // print anything already committed, before any live drawing goes on top
  window.Ink.bakeAll(BAKED, function (key) {
    var m = /^(\d+)([rv])$/.exec(key);
    if (!m || !leaves[m[1]]) return null;
    return leaves[m[1]].querySelector(
      m[2] === "r" ? ".face--front" : ".face--back"
    );
  });

  window.Ink.init(faces);
  window.Ink.setVisible(visibleFaces());
})();
