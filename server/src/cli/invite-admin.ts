import { env } from '../env.js';
import { issueFounderInvite } from '../lib/founder.js';
import { initHosted, tenantForSlug } from '../lib/tenants.js';

/*
  Re-issue the founder invitation for a family that has no administrator
  yet — the first one expired, went to a mistyped address, or the family
  was provisioned before invitations existed. Run inside the app container:

    docker compose exec app node server/dist/cli/invite-admin.js <slug> <address>

  The earlier unused invitation is retired; the family holds one live
  link. Refuses a family that already has an administrator — recovery for
  those goes through the app (reset by email) or admin-reset.mjs.
*/

if (!env.hostedMode) {
  console.error('This is a hosted-mode tool: set HOSTED_MODE=true and HOSTED_DOMAIN first.');
  process.exit(1);
}

const [slug, email, ...rest] = process.argv.slice(2);
if (!slug || !email || rest.length > 0) {
  console.error('Usage: invite-admin.js <slug> <address>');
  process.exit(1);
}

try {
  initHosted();
  const tenant = tenantForSlug(slug.toLowerCase());
  if (!tenant?.familyId) throw new Error(`No active family with slug "${slug}"`);
  const invite = await issueFounderInvite(tenant.familyId, email);
  if (invite.mailed) {
    console.log(`Invitation mailed to ${email}. It opens the first-run screen once, within a week.`);
  } else {
    console.log('Service mail is not configured — hand this link to the administrator yourself:');
    console.log(`  ${invite.url}`);
  }
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
