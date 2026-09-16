/*!
 * Aretia Finance -- footer bars
 * ---------------------------------------------------------------------
 * A smaller, muted variant of the homepage pulse-band bars for the
 * footer, shared across every page via this one file. Same interaction
 * as the homepage: on mousemove every bar jumps to full height except
 * the one under the cursor (which drops to its own resting height,
 * opening a notch) and its immediate left/right neighbors, which land
 * at two distinct partial heights rather than a symmetric dip. Static
 * (no listeners attached) under prefers-reduced-motion.
 *
 * Mount point: any element with [data-aretia-footer-bars]. Self-inits
 * on DOMContentLoaded -- a page just needs the mount element, this
 * script tag, and footer-bars.css, nothing else.
 */
(function () {
  "use strict";

  function init() {
    var field = document.querySelector("[data-aretia-footer-bars]");
    if (!field || field.dataset.awInit) return;
    field.dataset.awInit = "true";

    var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var COUNT = 28;
    var bars = [];
    var bases = [];

    for (var i = 0; i < COUNT; i++) {
      var base = 16 + Math.random() * 48;
      bases.push(base);
      var bar = document.createElement("div");
      bar.className = "fbar";
      bar.style.height = base + "%";
      field.appendChild(bar);
      bars.push(bar);
    }

    if (reduceMotion) return;

    var MAX_H = 96;
    var LEFT_NEIGHBOR_MULT = 0.45;
    var RIGHT_NEIGHBOR_MULT = 0.7;
    var pending = false;
    var lastX = null;

    function applyAt(clientX) {
      var rect = field.getBoundingClientRect();
      var relX = (clientX - rect.left) / rect.width;
      var centerIndex = Math.max(0, Math.min(COUNT - 1, Math.floor(relX * COUNT)));
      for (var i = 0; i < COUNT; i++) {
        var h, hi;
        if (i === centerIndex) {
          h = bases[i];
          hi = false;
        } else if (i === centerIndex - 1) {
          h = bases[i] + LEFT_NEIGHBOR_MULT * (MAX_H - bases[i]);
          hi = true;
        } else if (i === centerIndex + 1) {
          h = bases[i] + RIGHT_NEIGHBOR_MULT * (MAX_H - bases[i]);
          hi = true;
        } else {
          h = MAX_H;
          hi = true;
        }
        bars[i].style.height = h + "%";
        bars[i].classList.toggle("hi", hi);
      }
    }

    function reset() {
      for (var i = 0; i < COUNT; i++) {
        bars[i].style.height = bases[i] + "%";
        bars[i].classList.remove("hi");
      }
    }

    field.addEventListener("mousemove", function (e) {
      lastX = e.clientX;
      if (pending) return;
      pending = true;
      requestAnimationFrame(function () {
        applyAt(lastX);
        pending = false;
      });
    });
    field.addEventListener("mouseleave", reset);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
