import { randomUUID } from 'node:crypto';

// Additive: retain the existing local member IDs and every domain table.
export function createConnection(db) {
  if (!db.prepare('PRAGMA table_info(family_config)').all().some(c => c.name === 'household_id'))
    db.exec('ALTER TABLE family_config ADD COLUMN household_id TEXT');
  function householdId() {
    const existing = db.prepare('SELECT household_id FROM family_config WHERE id=1').get().household_id;
    if (existing) return existing;
    db.prepare('UPDATE family_config SET household_id=? WHERE id=1 AND household_id IS NULL').run(randomUUID());
    return db.prepare('SELECT household_id FROM family_config WHERE id=1').get().household_id;
  }
  householdId();
  return () => ({
    product: 'bathjun',
    apiVersion: 1,
    householdId: householdId(),
    mode: 'windows-server',
    capabilities: ['household-id', 'member-api', 'web-push'],
    // Do not advertise transfer/admin/native-push until the operations exist.
  });
}
