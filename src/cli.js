#!/usr/bin/env bun
/**
 * CLI pg-leaf: split / join / dump.
 *
 * split  dump.sql --output ./snapshot        дамп → дерево файлов
 * join   ./snapshot --output restored.sql    дерево → единый SQL (или --stdout)
 * dump   --database "$URL" --output ./snapshot   pg_dump → дерево
 */
import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join as joinPath, resolve } from "node:path";
import { $ } from "bun";
import { collect, RESTRICTION_KEY, splitFiles, statements } from "./sql.js";

/**
 * Потоково делит файл дампа на дерево снимка: два прохода по файлу,
 * память ограничена одним оператором. Дерево пишется во временную
 * директорию, прежний снимок заменяется только после успеха.
 */
export async function split(input, output) {
  const tables = new Map();
  for await (const { tokens } of statements(Bun.file(input).stream())) collect(tokens, tables);

  const destination = resolve(output);
  const parent = dirname(destination);
  await mkdir(parent, { recursive: true });
  const temporary = await mkdtemp(joinPath(parent, `.${basename(destination)}.tmp-`));
  const staging = joinPath(temporary, "snapshot");
  const backup = joinPath(temporary, "previous");
  let backedUp = false;
  let committed = false;
  try {
    await mkdir(staging);
    const exists = (path) => Bun.file(`${staging}/${path}`).exists();
    const outputs = new Map();
    try {
      for await (const [path, contents] of splitFiles(statements(Bun.file(input).stream()), tables, exists)) {
        const filename = joinPath(staging, path);
        let file = outputs.get(filename);
        if (!file) {
          await mkdir(dirname(filename), { recursive: true });
          file = await open(filename, "a");
          outputs.set(filename, file);
        }
        await file.writeFile(contents);
      }
    } finally {
      await Promise.all([...outputs.values()].map((file) => file.close()));
    }
    try {
      await rename(destination, backup);
      backedUp = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await rename(staging, destination);
    committed = true;
  } catch (error) {
    if (backedUp) {
      await rename(backup, destination);
      backedUp = false;
    }
    throw error;
  } finally {
    if (committed || !backedUp) await rm(temporary, { recursive: true, force: true });
  }
}

/** Потоково отдаёт .sql файлы снимка в детерминированном порядке путей, разделяя пустой строкой. */
export async function* join(snapshot) {
  const paths = [...new Bun.Glob("**/*.sql").scanSync(snapshot)].sort();
  const restrictionKey = randomBytes(32).toString("hex");
  for (const [index, path] of paths.entries()) {
    if (index) yield "\n";
    const contents = await Bun.file(`${snapshot}/${path}`).text();
    yield contents.replace(
      new RegExp(String.raw`^\\(restrict|unrestrict) ${RESTRICTION_KEY}$`, "gm"),
      `\\$1 ${restrictionKey}`,
    );
  }
}

/** Снимает plain-дамп базы во временный файл (нужны два прохода) и делит его. */
export async function dump(database, output) {
  const destination = resolve(output);
  const parent = dirname(destination);
  await mkdir(parent, { recursive: true });
  const temporary = await mkdtemp(joinPath(parent, `.${basename(destination)}.dump-`));
  const dumpFile = joinPath(temporary, "dump.sql");
  try {
    const pgDump = Bun.spawn(
      ["pg_dump", "--format=plain", "--column-inserts", "--rows-per-insert=1", "--quote-all-identifiers", "--encoding=UTF8", `--dbname=${database}`],
      { stderr: "inherit" },
    );
    await Bun.write(dumpFile, new Response(pgDump.stdout));
    if (await pgDump.exited) throw new Error("pg_dump failed");
    await split(dumpFile, output);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const { values: options, positionals: [command, input] } = parseArgs({
    args: Bun.argv.slice(2),
    options: { output: { type: "string" }, database: { type: "string" }, stdout: { type: "boolean" } },
    allowPositionals: true,
  });
  switch (command) {
    case "split":
      await split(input, options.output);
      break;
    case "join": {
      const writer = (options.stdout ? Bun.stdout : Bun.file(options.output)).writer();
      for await (const part of join(input)) writer.write(part);
      await writer.end();
      break;
    }
    case "dump":
      await dump(options.database, options.output);
      break;
    default:
      throw new Error("Usage: pg-leaf split <dump.sql> --output <dir> | join <dir> --output <file> | --stdout | dump --database <url> --output <dir>");
  }
}
