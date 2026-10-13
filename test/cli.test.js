import { afterAll, describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { $ } from "bun";
import { join as joinPath } from "node:path";
import { join, split } from "../src/cli.js";

const fixtures = joinPath(import.meta.dir, "../fixtures");
const temporary = joinPath(import.meta.dir, "../.test-output");

afterAll(async () => {
  await $`rm -rf ${temporary}`.quiet();
});

const tree = async (root) => {
  const paths = [...new Bun.Glob("**/*.sql").scanSync(root)].sort();
  return Promise.all(paths.map(async (path) => [path, await Bun.file(`${root}/${path}`).text()]));
};

const joined = async (snapshot) => {
  let text = "";
  for await (const part of join(snapshot)) text += part;
  return text;
};

describe("fixtures mirror each other", () => {
  test("split of fixtures/dump.sql reproduces fixtures/snapshot byte for byte", async () => {
    await split(`${fixtures}/dump.sql`, `${temporary}/snapshot`);
    expect(await tree(`${temporary}/snapshot`)).toEqual(await tree(`${fixtures}/snapshot`));
  });

  test("join of fixtures/snapshot reproduces fixtures/dump.sql byte for byte", async () => {
    expect(await joined(`${fixtures}/snapshot`)).toBe(await Bun.file(`${fixtures}/dump.sql`).text());
  });

  test("split and join form a fixed point", async () => {
    await Bun.write(`${temporary}/restored.sql`, await joined(`${fixtures}/snapshot`));
    await split(`${temporary}/restored.sql`, `${temporary}/roundtrip`);
    expect(await tree(`${temporary}/roundtrip`)).toEqual(await tree(`${fixtures}/snapshot`));
  });
});

describe("split", () => {
  test("keeps the previous snapshot when the dump cannot be split", async () => {
    await Bun.write(`${temporary}/ok.sql`, "CREATE TABLE public.items (id integer PRIMARY KEY);\nINSERT INTO public.items (id) VALUES (1);\n");
    await Bun.write(`${temporary}/bad.sql`, "INSERT INTO t (id) VALUES (1), (2);\n");
    await split(`${temporary}/ok.sql`, `${temporary}/kept`);
    await expect(split(`${temporary}/bad.sql`, `${temporary}/kept`)).rejects.toThrow();
    expect(await Bun.file(`${temporary}/kept/begin.sql`).text()).toContain("CREATE TABLE");
  });

  test("join preserves the statement order inside a transaction chunk", async () => {
    const dump =
      "BEGIN;\n" +
      "SELECT pg_catalog.lo_open('16385', 131072);\n" +
      "SELECT pg_catalog.lowrite(0, '\\x00');\n" +
      "SELECT pg_catalog.lo_close(0);\n" +
      "COMMIT;";
    await Bun.write(`${temporary}/transaction.sql`, dump);
    await split(`${temporary}/transaction.sql`, `${temporary}/transaction`);

    expect(await joined(`${temporary}/transaction`)).toBe(`${dump}\n`);
  });

  test("replaces the previous snapshot with an empty dump", async () => {
    await Bun.write(`${temporary}/ok.sql`, "CREATE TABLE public.items (id integer PRIMARY KEY);\n");
    await Bun.write(`${temporary}/empty.sql`, "");
    await split(`${temporary}/ok.sql`, `${temporary}/empty-snapshot`);
    await split(`${temporary}/empty.sql`, `${temporary}/empty-snapshot`);
    expect(await readdir(`${temporary}/empty-snapshot`)).toEqual([]);
  });
});
