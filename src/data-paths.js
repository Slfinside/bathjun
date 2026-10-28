import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
export function dataPaths(environment = process.env) {
  const directory = environment.BATHJUN_DATA_DIR
    ? resolve(environment.BATHJUN_DATA_DIR)
    : fileURLToPath(new URL("../data/", import.meta.url));
  const database = environment.BATHJUN_DB || join(directory, "bathjun.sqlite");
  return {
    directory,
    database,
    databaseDirectory: dirname(database),
    tunnelConfig: join(directory, "tunnel.yml"),
    publicLink: join(directory, "public-link.txt"),
  };
}
