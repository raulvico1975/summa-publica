import { config } from './config.mjs';
import { ensureDefaultOrg, backfillOrgIdForLegacyData } from './db.mjs';

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  console.log(`[MIGRATION] Data store: ${config.dataStore}`);
  console.log(`[MIGRATION] Default org id: ${config.defaultOrgId}`);

  if (dryRun) {
    console.log('[MIGRATION] Dry run actiu. No es fan canvis.');
    return;
  }

  const org = await ensureDefaultOrg();
  console.log(`[MIGRATION] Org per defecte preparada: ${org.id} (${org.name})`);

  const result = await backfillOrgIdForLegacyData(org.id);
  console.log('[MIGRATION] Backfill finalitzat.');
  console.log(`- posts actualitzats: ${result.postsUpdated}`);
  console.log(`- audit actualitzats: ${result.auditUpdated}`);
}

main().catch((err) => {
  console.error('[MIGRATION] Error:', err?.message || err);
  process.exitCode = 1;
});
