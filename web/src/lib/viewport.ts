import { useEffect } from 'react';

/*
  Where the bottom of the screen actually is, on a phone.

  Bottom bars are position:fixed against the LAYOUT viewport, and on iOS
  that is not the visible area: when the browser's own toolbar collapses
  or re-expands, or the keyboard goes away, the layout viewport catches up
  late — sometimes only on the next scroll, which a short page never
  produces. Seen on demo.neiliro.com in Chrome for iOS, 2026-09-16: the
  tab bar and the "More" sheet floating a toolbar's height above the real
  bottom with page background showing underneath.

  The visual viewport API says where the visible area ends right now. The
  gap between it and the layout viewport goes into --vv-bottom, and the
  bars sit `bottom: var(--vv-bottom)` instead of `bottom: 0`.

  One deliberate exception: the software keyboard. It shrinks the visual
  viewport by a third of the screen or more, and bars riding up to sit on
  top of it would eat what little room the form has left; a native tab
  bar disappears under the keyboard, and so do these. Anything under half
  the screen is a toolbar, anything over is a keyboard.
*/
const KEYBOARD_FRACTION = 0.5;
const VAR = '--vv-bottom';

export function useVisualViewportOffset(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const update = () => {
      const gap = window.innerHeight - (vv.height + vv.offsetTop);
      const px = gap > 0 && gap < window.innerHeight * KEYBOARD_FRACTION ? Math.round(gap) : 0;
      root.style.setProperty(VAR, `${px}px`);
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      root.style.removeProperty(VAR);
    };
  }, []);
}
