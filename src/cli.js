#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { splitDump } from "./sql.js";

function usage() {
  return `Usage:
  pg-leaf split <dump.sql> --output <snapshot-directory>
  pg-leaf join <snapshot-directory> [--output <restored.sql> | --stdout]
  pg-leaf dump --database <connection-string> --output <snapshot-directory>
`;
}

function parseArguments(args) {
  const options = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--output") {
      if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error("--output requires a path");
      options.output = args[++i];
    } else if (arg === "--database") {
      if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error("--database requires a connection string");
      options.database = args[++i];
    } else if (arg === "--stdout") {
      options.stdout = true;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  return { options, positional };
}

async function writeSnapshot(files, output) {
  const target = resolve(output);
  if (target === dirname(target)) throw new Error("Refusing to replace a filesystem root");
  const parent = dirname(target);
  const name = target.slice(parent.length + 1);
  await mkdir(parent, { recursive: true });
  const temporary = await mkdtemp(join(parent, `.${name}.tmp-`));
  let backup;

  try {
    for (const [path, contents] of files) {
      const destination = join(temporary, path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, contents, { encoding: "utf8", mode: 0o600 });
    }

    let existing;
    try {
      existing = await lstat(target);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (existing?.isSymbolicLink() || (existing && !existing.isDirectory())) {
      throw new Error("Output path must be a directory, not a file or symbolic link");
    }

    if (existing) {
      backup = `${target}.backup-${randomUUID()}`;
      await rename(target, backup);
    }
    try {
      await rename(temporary, target);
    } catch (error) {
      if (backup) await rename(backup, target);
      backup = undefined;
      throw error;
    }
    if (backup) await rm(backup, { recursive: true, force: true });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function collectSqlFiles(root) {
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Snapshot contains a symbolic link: ${path}`);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && entry.name.endsWith(".sql")) {
        files.push(path);
      } else if (!entry.isFile()) {
        throw new Error(`Snapshot contains an unsupported filesystem entry: ${path}`);
      }
    }
  }
  await visit(root);
  files.sort((a, b) => Buffer.compare(Buffer.from(relative(root, a).split(sep).join("/")), Buffer.from(relative(root, b).split(sep).join("/"))));
  return files;
}

async function* joinedSql(input) {
  const root = resolve(input);
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Snapshot path must be a directory");
  const paths = await collectSqlFiles(root);
  for (const path of paths) {
    let lastByte;
    for await (const chunk of createReadStream(path)) {
      if (chunk.length) lastByte = chunk.at(-1);
      yield chunk;
    }
    if (lastByte !== undefined && lastByte !== 10) yield Buffer.from("\n");
  }
}

async function runPgDump(database, path) {
  const child = spawn(
    "pg_dump",
    [
      "--format=plain",
      "--column-inserts",
      "--rows-per-insert=1",
      "--quote-all-identifiers",
      "--encoding=UTF8",
      `--dbname=${database}`,
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  const exit = new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", (code, signal) => {
      if (code === 0) resolveExit();
      else rejectExit(new Error(`pg_dump failed${signal ? ` (${signal})` : ` with exit code ${code}`}`));
    });
  });
  await Promise.all([
    pipeline(child.stdout, createWriteStream(path, { mode: 0o600 })),
    exit,
  ]);
}

export async function main(args) {
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(usage());
    return 0;
  }
  const { options, positional } = parseArguments(rest);

  if (command === "split") {
    if (positional.length !== 1 || !options.output || options.stdout) {
      throw new Error(`split requires one dump path and --output\n${usage()}`);
    }
    const sql = await readFile(resolve(positional[0]), "utf8");
    const files = splitDump(sql);
    await writeSnapshot(files, options.output);
    return 0;
  }
  if (command === "dump") {
    if (positional.length || !options.database || !options.output || options.stdout) {
      throw new Error(`dump requires --database and --output\n${usage()}`);
    }
    const temporary = await mkdtemp(join(tmpdir(), "pg-leaf-dump-"));
    try {
      const dumpPath = join(temporary, "dump.sql");
      await runPgDump(options.database, dumpPath);
      const sql = await readFile(dumpPath, "utf8");
      await writeSnapshot(splitDump(sql), options.output);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
    return 0;
  }
  if (command === "join") {
    if (positional.length !== 1 || (options.stdout && options.output)) {
      throw new Error(`join requires one snapshot directory and either --output or --stdout\n${usage()}`);
    }
    const output = options.stdout
      ? process.stdout
      : options.output
        ? createWriteStream(resolve(options.output), { mode: 0o600 })
        : null;
    if (!output) throw new Error(`join requires --output or --stdout\n${usage()}`);
    await pipeline(Readable.from(joinedSql(positional[0])), output);
    return 0;
  }
  throw new Error(`Unknown command: ${command}\n${usage()}`);
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`pg-leaf: ${error.message}\n`);
      process.exitCode = 1;
    },
  );
}
