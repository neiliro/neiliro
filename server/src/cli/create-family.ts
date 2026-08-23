import { env } from '../env.js';
import { createFamily, initHosted } from '../lib/tenants.js';

/*
  Provision one family on a hosted server. Run inside the app container:

    docker compose exec app node server/dist/cli/create-family.js <slug>

  Needs HOSTED_MODE/HOSTED_DOMAIN in the environment (the container
  already has them). The printed URL is the whole onboarding: the first
  person to open it gets the ordinary first-run screen and becomes the
  family's admin — hand the link to the family, nothing else to do.

  Slugs by convention: <family name in latin>-<4 random chars>, e.g.
  "petrovs-x7k2". The suffix designs collisions out; vanity renames are a
  later, self-serve feature.
*/

if (!env.hostedMode) {
  console.error('This is a hosted-mode tool: set HOSTED_MODE=true and HOSTED_DOMAIN first.');
  process.exit(1);
}

const slug = process.argv[2];
if (!slug || process.argv.length > 3) {
  console.error('Usage: create-family.js <slug>');
  process.exit(1);
}

try {
  initHosted();
  const { familyId, url } = createFamily(slug.toLowerCase());
  console.log(`Family created: ${url}`);
  console.log(`  id: ${familyId}`);
  console.log('  The first visit shows the first-run screen and creates the admin.');
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
