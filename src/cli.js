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
import { collect, splitFiles, statements } from "./sql.js";

/**
 * Потоково делит файл дампа на дерево снимка: два прохода по файлу,
 * память ограничена одним оператором. Дерево пишется во временную
 * директорию, прежний снимок заменяется только после успеха.
 */
export async function split(input, output) {
  const tables = new Map();
  for await (const { tokens } of statements(Bun.file(input).stream())) collect(tokens, tables);

  const temporary = `${output}.tmp`;
  const exists = (path) => Bun.file(`${temporary}/${path}`).exists();
  await $`rm -rf ${temporary}`.quiet();
  try {
    for await (const [path, contents] of splitFiles(statements(Bun.file(input).stream()), tables, exists)) {
      await Bun.write(`${temporary}/${path}`, contents);
    }
    await $`rm -rf ${output}`.quiet();
    await $`mv ${temporary} ${output}`.quiet();
  } finally {
    await $`rm -rf ${temporary}`.quiet();
  }
}

/** Потоково отдаёт .sql файлы снимка в детерминированном порядке путей, разделяя пустой строкой. */
export async function* join(snapshot) {
  const paths = [...new Bun.Glob("**/*.sql").scanSync(snapshot)].sort();
  for (const [index, path] of paths.entries()) {
    if (index) yield "\n";
    yield await Bun.file(`${snapshot}/${path}`).text();
  }
}

/** Снимает plain-дамп базы во временный файл (нужны два прохода) и делит его. */
export async function dump(database, output) {
  const pgDump = Bun.spawn(
    ["pg_dump", "--format=plain", "--column-inserts", "--rows-per-insert=1", "--quote-all-identifiers", "--encoding=UTF8", `--dbname=${database}`],
    { stderr: "inherit" },
  );
  const temporary = `${output}.dump.sql`;
  try {
    await Bun.write(temporary, new Response(pgDump.stdout));
    if (await pgDump.exited) throw new Error("pg_dump failed");
    await split(temporary, output);
  } finally {
    await $`rm -f ${temporary}`.quiet();
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
