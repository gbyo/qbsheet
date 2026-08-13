/**
 * The product page's scroll reveals, and the reason nothing on the page is hidden until this file runs.
 *
 * # Hiding is done here, not in the stylesheet
 *
 * The obvious arrangement — a stylesheet that starts every revealable block at `opacity: 0` and a
 * script that clears it — has one failure mode, and it is total: a script that does not arrive leaves a
 * blank page. That was survivable when the markup itself needed JavaScript. It is not survivable now
 * that the page is static HTML, because a reader with a blocked or failed bundle would otherwise be
 * getting the whole article and would instead get nothing.
 *
 * So the resting state of the document is the finished state. This file marks blocks `pending`, which
 * is what the `[data-reveal='pending']` rules in `about.css` respond to, and then unmarks them. No
 * script, no marking, no hiding, and every word on screen.
 *
 * # Only what is below the fold
 *
 * A block already on screen when this runs is left exactly as the browser painted it. Hiding it a frame
 * after first paint in order to fade it back in is a flicker traded for an entrance nobody asked for,
 * and it is worst on the slow device where the trade is most visible.
 *
 * # Once
 *
 * Each block is unobserved as it arrives. A rule that redraws itself every time somebody scrolls back
 * up is decoration; only the first pass tells the reader anything.
 */

/** The heading blocks and grids that fade up, plus the workflow, whose stages are sequenced in CSS. */
const revealSelector = '.about-reveal, .about-stages';

/**
 * Whether this browser can animate an entrance and has not been asked to stop.
 *
 * Deliberately asks for `no-preference` rather than the absence of `reduce`. A browser too old to
 * understand the query answers "no" to both, and of the two possible readings of that silence the safe
 * one is to leave the page still.
 */
function animationIsWanted(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  if (typeof IntersectionObserver !== 'function') return false;
  if (typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: no-preference)').matches;
  } catch {
    return false;
  }
}

export default function startReveals(): void {
  if (!animationIsWanted()) return;

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        (entry.target as HTMLElement).removeAttribute('data-reveal');
        observer.unobserve(entry.target);
      }
    },
    // Enough of a block on screen that its entrance is watched rather than already over.
    { threshold: 0.15 },
  );

  for (const target of document.querySelectorAll<HTMLElement>(revealSelector)) {
    if (target.getBoundingClientRect().top < window.innerHeight) continue;
    target.dataset.reveal = 'pending';
    observer.observe(target);
  }
}
