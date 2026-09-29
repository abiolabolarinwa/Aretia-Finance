import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { SplitText } from 'gsap/SplitText';
import Lenis from 'lenis';

gsap.registerPlugin(ScrollTrigger, SplitText);

export { gsap, ScrollTrigger, SplitText };

export const reducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
export const finePointer = (): boolean => window.matchMedia('(hover: hover) and (pointer: fine)').matches;
export const isDesktop = (): boolean => window.matchMedia('(min-width: 1024px)').matches;

let lenis: Lenis | null = null;
export const getLenis = (): Lenis | null => lenis;

/** Inertial smooth scrolling on fine-pointer devices only; touch keeps native scrolling. */
function initSmoothScroll(): void {
  if (reducedMotion() || !finePointer()) return;
  lenis = new Lenis({ duration: 1.1, easing: (t) => 1 - Math.pow(1 - t, 4), smoothWheel: true });
  lenis.on('scroll', ScrollTrigger.update);
  gsap.ticker.add((time) => lenis?.raf(time * 1000));
  gsap.ticker.lagSmoothing(0);
  document.addEventListener('click', (event) => {
    const link = (event.target as Element).closest<HTMLAnchorElement>('a[href^="#"]');
    if (!link || link.getAttribute('href') === '#') return;
    const target = document.querySelector(link.getAttribute('href')!);
    if (!target) return;
    event.preventDefault();
    lenis?.scrollTo(target as HTMLElement, { offset: -80 });
  });
}

/** [data-reveal]: fade/translate in once, batched so siblings stagger together. */
function initReveals(): void {
  ScrollTrigger.batch('[data-reveal]', {
    start: 'top 88%',
    once: true,
    onEnter: (batch) =>
      gsap.to(batch, { opacity: 1, y: 0, scale: 1, duration: 1.1, ease: 'expo.out', stagger: 0.08, overwrite: true }),
  });
}

/** [data-split]: masked line-by-line heading reveal. `data-split="load"` plays immediately (hero). */
function initSplitHeadings(): void {
  document.querySelectorAll<HTMLElement>('[data-split]').forEach((el) => {
    const onLoad = el.dataset.split === 'load';
    const delay = Number(el.dataset.splitDelay ?? 0);
    SplitText.create(el, {
      type: 'lines',
      mask: 'lines',
      linesClass: 'split-line',
      autoSplit: true,
      onSplit(self) {
        return gsap.from(self.lines, {
          yPercent: 110,
          duration: 1.2,
          ease: 'expo.out',
          stagger: 0.09,
          delay,
          scrollTrigger: onLoad ? undefined : { trigger: el, start: 'top 85%', once: true },
        });
      },
    });
  });
}

/** [data-parallax="0.15"]: drift against scroll by that fraction of the element's height. */
function initParallax(): void {
  document.querySelectorAll<HTMLElement>('[data-parallax]').forEach((el) => {
    const speed = Number(el.dataset.parallax ?? 0.15);
    gsap.fromTo(
      el,
      { yPercent: speed * 50 },
      { yPercent: -speed * 50, ease: 'none', scrollTrigger: { trigger: el, start: 'top bottom', end: 'bottom top', scrub: true } },
    );
  });
}

/** [data-count="1000000000"]: count up once visible. Only for real, documented figures. */
function initCounters(): void {
  document.querySelectorAll<HTMLElement>('[data-count]').forEach((el) => {
    const target = Number(el.dataset.count);
    const decimals = Number(el.dataset.decimals ?? 0);
    const suffix = el.dataset.suffix ?? '';
    const format = (v: number) =>
      v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) + suffix;
    el.textContent = format(0);
    const state = { value: 0 };
    gsap.to(state, {
      value: target,
      duration: 2.2,
      ease: 'expo.out',
      onUpdate: () => (el.textContent = format(state.value)),
      scrollTrigger: { trigger: el, start: 'top 90%', once: true },
    });
  });
}

/** [data-magnetic]: subtle pull toward the pointer (max ~6px). */
function initMagnetic(): void {
  if (!finePointer()) return;
  document.querySelectorAll<HTMLElement>('[data-magnetic]').forEach((el) => {
    const strength = Number(el.dataset.magnetic || 0.25);
    const xTo = gsap.quickTo(el, 'x', { duration: 0.6, ease: 'power3.out' });
    const yTo = gsap.quickTo(el, 'y', { duration: 0.6, ease: 'power3.out' });
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      xTo(Math.max(-6, Math.min(6, (e.clientX - r.left - r.width / 2) * strength)));
      yTo(Math.max(-6, Math.min(6, (e.clientY - r.top - r.height / 2) * strength)));
    });
    el.addEventListener('pointerleave', () => {
      xTo(0);
      yTo(0);
    });
  });
}

/** [data-tilt]: gentle 3D tilt toward the pointer (wallet mockups, cards). */
function initTilt(): void {
  if (!finePointer()) return;
  document.querySelectorAll<HTMLElement>('[data-tilt]').forEach((el) => {
    const max = Number(el.dataset.tilt || 6);
    const rx = gsap.quickTo(el, 'rotationX', { duration: 0.8, ease: 'power3.out' });
    const ry = gsap.quickTo(el, 'rotationY', { duration: 0.8, ease: 'power3.out' });
    gsap.set(el, { transformPerspective: 1200 });
    const zone = el.closest<HTMLElement>('[data-tilt-zone]') ?? el;
    zone.addEventListener('pointermove', (e) => {
      const r = zone.getBoundingClientRect();
      ry(((e.clientX - r.left) / r.width - 0.5) * max * 2);
      rx(-((e.clientY - r.top) / r.height - 0.5) * max * 2);
    });
    zone.addEventListener('pointerleave', () => {
      rx(0);
      ry(0);
    });
  });
}

let started = false;
export function initMotion(): void {
  if (started) return;
  started = true;
  (window as unknown as { __aretiaMotion?: boolean }).__aretiaMotion = true;
  if (reducedMotion()) {
    document.documentElement.classList.remove('motion-ok');
    return;
  }
  initSmoothScroll();
  initReveals();
  initSplitHeadings();
  initParallax();
  initCounters();
  initMagnetic();
  initTilt();
  window.addEventListener('load', () => ScrollTrigger.refresh());
}
