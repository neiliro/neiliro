import { describe, expect, it } from 'vitest';
import { supportLink } from './support';

describe('supportLink', () => {
  it('sends a self-hosted family to the issue tracker', () => {
    const link = supportLink(false, 'hub.example.com');
    expect(link?.label).toBe('Report a bug');
    expect(link?.href).toContain('github.com');
  });

  it('sends a hosted family to the support site', () => {
    const link = supportLink(true, 'zgmnd.neiliro.com');
    expect(link?.label).toBe('Support');
    expect(link?.href).toBe('https://support.neiliro.com');
  });

  /*
    The bug this pins was found on production: the footer rendered the
    self-hoster's link — live, pointing at GitHub — for as long as
    /auth/state was in flight, on the very screen a locked-out hosted
    family reads it. "Not told yet" is not "not hosted", so there is
    nothing honest to render until the answer lands.
  */
  it('offers no link at all while the answer is unknown', () => {
    expect(supportLink(null, 'zgmnd.neiliro.com')).toBeNull();
    expect(supportLink(null, 'hub.example.com')).toBeNull();
  });

  /*
    Hosted mode is in the open-source repo, so someone else can run a
    service of their own. Their families are not our families: a hardcoded
    "Support" link would route their messages into our inbox.
  */
  it('does not send someone else’s hosted service to our help desk', () => {
    expect(supportLink(true, 'smith.familyhub.example')?.label).toBe('Report a bug');
  });

  /* A domain that merely ends in the same letters is not our domain. */
  it('is not fooled by a lookalike domain', () => {
    expect(supportLink(true, 'evil-neiliro.com')?.label).toBe('Report a bug');
    expect(supportLink(true, 'neiliro.com.attacker.example')?.label).toBe('Report a bug');
  });
});
