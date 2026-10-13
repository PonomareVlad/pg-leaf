#!/usr/bin/env bun
/**
 * CLI pg-leaf: split / join / dump.
 *
 * split  dump.sql --output ./snapshot        дамп → дерево файлов
 * join   ./snapshot --output restored.sql    дерево → единый SQL (или --stdout)
 * dump   --database "$URL" --output ./snapshot   pg_dump → дерево
 */
import { parseArgs } from "node:util";
import { $ } from "bun";
import { splitDump } from "./sql.js";

/** Делит дамп и записывает дерево снимка, заменяя прежний снимок только после успешного разбора. */
export async function split(sql, output) {
  const files = splitDump(sql);
  await $`rm -rf ${output}`.quiet();
  for (const [path, contents] of files) await Bun.write(`${output}/${path}`, contents);
}

/** Склеивает все .sql файлы снимка в детерминированном порядке путей в единый SQL. */
export async function join(snapshot) {
  const paths = [...new Bun.Glob("**/*.sql").scanSync(snapshot)].sort();
  const files = await Promise.all(paths.map((path) => Bun.file(`${snapshot}/${path}`).text()));
  return files.join("\n");
}

/** Возвращает plain-дамп базы: по одному INSERT на запись, идентификаторы в кавычках, UTF-8. */
export async function dump(database) {
  const pgDump = Bun.spawn(
    ["pg_dump", "--format=plain", "--column-inserts", "--rows-per-insert=1", "--quote-all-identifiers", "--encoding=UTF8", `--dbname=${database}`],
    { stderr: "inherit" },
  );
  const sql = await new Response(pgDump.stdout).text();
  if (await pgDump.exited) throw new Error("pg_dump failed");
  return sql;
}

if (import.meta.main) {
  const { values: options, positionals: [command, input] } = parseArgs({
    args: Bun.argv.slice(2),
    options: { output: { type: "string" }, database: { type: "string" }, stdout: { type: "boolean" } },
    allowPositionals: true,
  });
  switch (command) {
    case "split":
      await split(await Bun.file(input).text(), options.output);
      break;
    case "join":
      await Bun.write(options.stdout ? Bun.stdout : options.output, await join(input));
      break;
    case "dump":
      await split(await dump(options.database), options.output);
      break;
    default:
      throw new Error("Usage: pg-leaf split <dump.sql> --output <dir> | join <dir> --output <file> | --stdout | dump --database <url> --output <dir>");
  }
}
