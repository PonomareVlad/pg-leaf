import { afterAll, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { randomUUID } from "node:crypto";
import { join as joinPath } from "node:path";
import { dump, join, split } from "../src/cli.js";

const fixtures = joinPath(import.meta.dir, "../fixtures");
const suffix = randomUUID().replaceAll("-", "");
const temporary = joinPath(import.meta.dir, `../.integration-output-${suffix}`);
const sourceDatabase = `leaf_source_${suffix}`;
const restoredDatabase = `leaf_restored_${suffix}`;
const url = (database) => `postgres://localhost:5432/${database}`; // учётные данные берутся из PGUSER/PGPASSWORD

const psql = (database, ...args) => $`psql -X -q -v ON_ERROR_STOP=1 -d ${url(database)} ${args}`.quiet();
const recreate = async (database) => {
  await $`psql -X -q -d ${url("postgres")} -c ${`DROP DATABASE IF EXISTS "${database}"`} -c ${`CREATE DATABASE "${database}"`}`.quiet();
};

afterAll(async () => {
  await Promise.all([sourceDatabase, restoredDatabase].map((database) =>
    $`psql -X -q -d ${url("postgres")} -c ${`DROP DATABASE IF EXISTS "${database}"`}`.quiet(),
  ));
  await $`rm -rf ${temporary}`.quiet();
});

describe("round trip through PostgreSQL", () => {
  test("pg_dump → split → join → psql restores an identical database", async () => {
    await recreate(sourceDatabase);
    await psql(sourceDatabase, "-f", `${fixtures}/dump.sql`);

    await dump(url(sourceDatabase), `${temporary}/snapshot`);
    let restored = "";
    for await (const part of join(`${temporary}/snapshot`)) restored += part;
    await Bun.write(`${temporary}/restored.sql`, restored);

    await recreate(restoredDatabase);
    await psql(restoredDatabase, "-f", `${temporary}/restored.sql`);

    const flags = ["--format=plain", "--column-inserts", "--rows-per-insert=1", "--quote-all-identifiers", "--encoding=UTF8"];
    const snapshot = async (database) => {
      const sql = await $`pg_dump ${flags} --dbname=${url(database)}`.text();
      return sql.replace(/^\\(un)?restrict .*$/gm, ""); // случайный токен pg_dump ≥ 16.10
    };
    expect(await snapshot(restoredDatabase)).toBe(await snapshot(sourceDatabase));
  }, 30000);

  test("split of a real pg_dump is a fixed point", async () => {
    await Bun.write(`${temporary}/once.sql`, (await Bun.file(`${temporary}/restored.sql`).text()));
    await split(`${temporary}/once.sql`, `${temporary}/again`);
    const tree = async (root) => {
      const paths = [...new Bun.Glob("**/*.sql").scanSync(root)].sort();
      return Promise.all(paths.map(async (path) => [path, await Bun.file(`${root}/${path}`).text()]));
    };
    expect(await tree(`${temporary}/again`)).toEqual(await tree(`${temporary}/snapshot`));
  }, 30000);
});
