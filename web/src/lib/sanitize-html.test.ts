// @vitest-environment happy-dom
// @vitest-environment-options { "settings": { "disableJavaScriptEvaluation": true, "disableJavaScriptFileLoading": true, "disableCSSFileLoading": true, "disableIframePageLoading": true } }
import { describe, expect, it } from 'vitest';
import { htmlWorthShowing, sanitizeHtml } from './sanitize-html';

/*
  The allowlist is the security boundary for every letter a family opens,
  so the test speaks the attacker's dialect: scripts and handlers, javascript:
  links, tracking pixels, forms, styles, and the mutation-XSS shapes that
  survive string round-trips. What must survive is the paperwork: a table
  of charges, a bold total, a link to the portal, an inline image.
*/

function render(html: string): { text: string; html: string; blocked: number } {
  const out = sanitizeHtml(html);
  const div = document.createElement('div');
  div.appendChild(out.fragment);
  return { text: div.textContent ?? '', html: div.innerHTML, blocked: out.blockedImages };
}

describe('sanitizeHtml', () => {
  it('keeps the paperwork: structure, emphasis, tables, safe links', () => {
    const r = render(
      '<html><body><h2>Your bill</h2><p>Total: <b>64.20 EUR</b></p><table><tr><td>Water</td><td>12.00</td></tr></table>' +
        '<p><a href="https://portal.power.example/pay?id=7">Pay online</a></p></body></html>',
    );
    expect(r.text).toContain('Your bill');
    expect(r.html).toContain('<b>64.20 EUR</b>');
    expect(r.html).toContain('<td>Water</td>');
    expect(r.html).toMatch(/<a href="https:\/\/portal\.power\.example\/pay\?id=7" target="_blank" rel="noopener noreferrer nofollow">Pay online<\/a>/);
  });

  it('drops scripts, handlers, styles, forms and javascript: links, words of the first included', () => {
    const r = render(
      '<p onclick="steal()" style="display:none" class="x" id="y">Hello</p>' +
        '<script>steal()</script><style>p{display:none}</style>' +
        '<a href="javascript:alert(1)">click</a>' +
        '<form action="https://evil.example"><input name="pw"></form>' +
        '<iframe src="https://evil.example"></iframe>' +
        '<p><span onmouseover="x()">fine</span></p>',
    );
    expect(r.html).toBe('<p>Hello</p><a>click</a><p><span>fine</span></p>');
    expect(r.html).not.toContain('steal');
    expect(r.html).not.toContain('style');
  });

  it('blocks remote images and counts them, keeps inline data: images', () => {
    const r = render(
      '<img src="https://track.example/pixel.gif" width="1" height="1">' +
        '<img src="data:image/png;base64,iVBORw0KGgo=" alt="logo">' +
        '<img src="data:text/html;base64,PHNjcmlwdD4=">',
    );
    expect(r.blocked).toBe(2);
    expect(r.html).toBe('<img src="data:image/png;base64,iVBORw0KGgo=" alt="logo" loading="lazy">');
  });

  it('does not let mutation-XSS shapes through, because nothing is re-parsed', () => {
    // The paragraph comes first: a test parser without foreign-content
    // rules may swallow what follows an <svg> into it, a browser does not
    const r = render('<p>after</p><noscript><p title="</noscript><img src=x onerror=alert(1)>">x</p></noscript><svg><style><img src=x onerror=alert(1)></style></svg>');
    expect(r.html).not.toContain('onerror');
    expect(r.html).not.toContain('<img');
    expect(r.text).toContain('after');
  });

  it('reports an empty result for HTML that says nothing', () => {
    const out = sanitizeHtml('<html><body><script>x()</script><div style="x"></div></body></html>');
    expect(out.empty).toBe(true);
  });
});

describe('htmlWorthShowing', () => {
  it('recognises markup that carries more than the text part', () => {
    expect(htmlWorthShowing('<p>Just words</p>')).toBe(false);
    expect(htmlWorthShowing('<table><tr><td>1</td></tr></table>')).toBe(true);
    expect(htmlWorthShowing(null)).toBe(false);
  });
});
