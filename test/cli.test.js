import { afterAll, describe, expect, test } from "bun:test";
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

describe("fixtures mirror each other", () => {
  test("split of fixtures/dump.sql reproduces fixtures/snapshot byte for byte", async () => {
    await split(await Bun.file(`${fixtures}/dump.sql`).text(), `${temporary}/snapshot`);
    expect(await tree(`${temporary}/snapshot`)).toEqual(await tree(`${fixtures}/snapshot`));
  });

  test("join of fixtures/snapshot reproduces fixtures/dump.sql byte for byte", async () => {
    expect(await join(`${fixtures}/snapshot`)).toBe(await Bun.file(`${fixtures}/dump.sql`).text());
  });

  test("split and join form a fixed point", async () => {
    const restored = await join(`${fixtures}/snapshot`);
    await split(restored, `${temporary}/roundtrip`);
    expect(await tree(`${temporary}/roundtrip`)).toEqual(await tree(`${fixtures}/snapshot`));
  });
});

describe("split", () => {
  test("keeps the previous snapshot when the dump cannot be parsed", async () => {
    await split("CREATE TABLE public.items (id integer PRIMARY KEY);", `${temporary}/kept`);
    await expect(split("INSERT INTO t (id) VALUES (1), (2);", `${temporary}/kept`)).rejects.toThrow();
    expect(await Bun.file(`${temporary}/kept/00-pre.sql`).text()).toContain("CREATE TABLE");
  });
});
