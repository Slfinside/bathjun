// Rebuild only the start column; retain existing fields, rows, indexes and triggers.
export function migrateDurationOnlyWishes(db) {
  const name = '0021_duration_only_wishes';
  if (db.prepare('SELECT 1 FROM schema_migrations WHERE name=?').get(name)) return;
  db.exec('SAVEPOINT duration_only_migration');
  try {
    const column = db.prepare('PRAGMA table_info(wishes)').all().find(c => c.name === 'start');
    if (column.notnull) {
      const source = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='wishes'").get().sql;
      const nullable = source.replace(/\bstart\s+INTEGER\s+NOT\s+NULL/i, 'start INTEGER');
      if (nullable === source) throw Error('希望の開始時刻の移行形式を確認できませんでした。');
      const extras = db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name='wishes' AND type IN ('index','trigger') AND sql IS NOT NULL").all();
      const rebuilt = nullable.replace(/^CREATE TABLE\s+(?:"[^"]+"|[a-z_]+)\s*/i, 'CREATE TABLE wishes_duration_only ');
      db.exec(rebuilt);
      db.exec('INSERT INTO wishes_duration_only SELECT * FROM wishes; DROP TABLE wishes; ALTER TABLE wishes_duration_only RENAME TO wishes');
      for (const extra of extras) db.exec(extra.sql);
    }
    db.prepare('INSERT INTO schema_migrations VALUES(?)').run(name);
    db.exec('RELEASE duration_only_migration');
  } catch (error) {
    db.exec('ROLLBACK TO duration_only_migration; RELEASE duration_only_migration');
    throw error;
  }
}
