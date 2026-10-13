import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.js";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("CLI", () => {
  test("splits and joins a SQL dump", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pg-leaf-test-"));
    temporaryDirectories.push(directory);
    const dump = join(directory, "dump.sql");
    const snapshot = join(directory, "snapshot");
    const restored = join(directory, "restored.sql");
    await writeFile(dump, "CREATE TABLE public.items (id integer PRIMARY KEY);\nINSERT INTO public.items (id) VALUES (12);\n");

    await main(["split", dump, "--output", snapshot]);
    await main(["join", snapshot, "--output", restored]);

    const sql = await readFile(restored, "utf8");
    expect(sql).toContain("CREATE TABLE public.items");
    expect(sql).toContain("INSERT INTO public.items (id) VALUES (12);");
  });

  test("leaves an existing snapshot untouched when splitting fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pg-leaf-test-"));
    temporaryDirectories.push(directory);
    const dump = join(directory, "dump.sql");
    const snapshot = join(directory, "snapshot");
    await writeFile(dump, "INSERT INTO t (id) VALUES (1), (2);");
    await main(["split", dump, "--output", snapshot]).catch(() => {});
    await writeFile(dump, "CREATE TABLE public.items (id integer PRIMARY KEY);");
    await main(["split", dump, "--output", snapshot]);
    await writeFile(dump, "INSERT INTO t (id) VALUES (1), (2);");

    await expect(main(["split", dump, "--output", snapshot])).rejects.toThrow();
    expect(await readFile(join(snapshot, "00-pre.sql"), "utf8")).toContain("CREATE TABLE public.items");
  });
});
