import { env } from '../env.js';
import { issueFounderInvite } from '../lib/founder.js';
import { createFamily, initHosted } from '../lib/tenants.js';

/*
  Provision one family on a hosted server. Run inside the app container:

    docker compose exec app node server/dist/cli/create-family.js <slug> --admin-email sam@example.com
    docker compose exec app node server/dist/cli/create-family.js <slug> --no-invite

  Needs HOSTED_MODE/HOSTED_DOMAIN in the environment (the container
  already has them). With --admin-email the invitation is mailed to that
  address: it opens the ordinary first-run screen, once, and the account
  it creates has the address confirmed for password recovery (#157). A
  bare family URL opens nothing.

  --no-invite is the operator's own escape hatch — smoke tests, or a
  laptop handed over in person: the printed URL shows the open first-run
  screen to whoever opens it first, exactly as before #157. Not for
  families you cannot see.

  To re-issue an expired invitation: invite-admin.js <slug> <email>.

  Slugs by convention: <family name in latin>-<4 random chars>, e.g.
  "petrovs-x7k2". The suffix designs collisions out; the family may rename
  itself once within its first day.
*/

if (!env.hostedMode) {
  console.error('This is a hosted-mode tool: set HOSTED_MODE=true and HOSTED_DOMAIN first.');
  process.exit(1);
}

const usage = 'Usage: create-family.js <slug> (--admin-email <address> | --no-invite)';
const [slug, flag, value, ...rest] = process.argv.slice(2);
const noInvite = flag === '--no-invite' && value === undefined;
const adminEmail = flag === '--admin-email' && value ? value : null;
if (!slug || rest.length > 0 || (!noInvite && !adminEmail)) {
  console.error(usage);
  process.exit(1);
}

try {
  initHosted();
  const { familyId, url } = createFamily(slug.toLowerCase());
  console.log(`Family created: ${url}`);
  console.log(`  id: ${familyId}`);
  if (adminEmail) {
    const invite = await issueFounderInvite(familyId, adminEmail);
    if (invite.mailed) {
      console.log(`  Invitation mailed to ${adminEmail}. It opens the first-run screen once, within a week.`);
    } else {
      console.log('  Service mail is not configured — hand this link to the administrator yourself:');
      console.log(`  ${invite.url}`);
    }
  } else {
    console.log('  No invitation: the first visit shows the open first-run screen and creates the admin.');
  }
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
