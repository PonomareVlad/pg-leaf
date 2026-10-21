#!/usr/bin/env bun
// pg-leaf — reversible splitting of PostgreSQL dumps into Git-friendly files

import {appendFile, mkdir, readdir, rm} from "node:fs/promises";
import {format} from "sql-formatter";
import {columns, lines, split, statements, unformat, uniques, values} from "./sql.js";

const usage = `Usage:
  pg-leaf split <dump.sql> <output-dir> [-v]
  pg-leaf join <output-dir> <dump.sql> [-v]`;

const verbose = Bun.argv.includes("-v");

// by default only table (directory) transitions are logged; -v adds per-file logs
const log = text => verbose && console.log(text);

// injective percent-encoding: `%` and every non-[\w-] byte become fixed-width `%XX`,
// so distinct names never collide and encoded paths cannot form `.` or `..`
const safe = name => name.replaceAll(/[^\w-]/gu, char =>
    Array.from(new TextEncoder().encode(char), byte => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`).join(""));

const sha256 = text => new Bun.CryptoHasher("sha256").update(text).digest("hex");

// hash key column values when the table has a unique key and the row parses cleanly,
// so chunk names stay stable while non-key columns change; otherwise hash the whole INSERT
const identity = (text, cols, key) => {
    const row = values(text);
    const indexes = key?.map(column => cols?.indexOf(column) ?? -1);
    return indexes?.every(index => index >= 0) && row.length === cols.length
        ? indexes.map(index => row[index]).join(", ")
        : text;
};

const write = async (path, text) => {
    log(`write ${path}`);
    await Bun.write(path, text);
};

const writeTable = async (dir, lines, cols, key) => {
    console.log(`table ${dir}`);
    await mkdir(dir, {recursive: true});
    const used = new Set();
    for (const {kind, text} of statements(lines)) {
        switch (kind) {
            case "insert": {
                // hash the single-line canonical form so formatted and raw chunks name identically
                const hash = sha256(identity(unformat(text), cols, key));
                let file = `${hash}.sql`;
                for (let n = 2; used.has(file); n++) file = `${hash}.${n}.sql`;
                used.add(file);
                await write(`${dir}/${file}`, format(text, {language: "postgresql"}) + "\n");
                break;
            }
            default:
                if (!used.has("0.sql")) used.add("0.sql"), log(`write ${dir}/0.sql`);
                await appendFile(`${dir}/0.sql`, text);
        }
    }
};

const splitCommand = async (input, output) => {
    const sql = await Bun.file(input).text();
    const [chunks, cols, keys] = [split(sql), columns(lines(sql)), uniques(lines(sql))];
    await rm(output, {recursive: true, force: true});
    // numbered chunks keep header → data → footer order under plain alphabetical sort
    for (const {kind, schema, name, lines: chunk} of chunks)
        if (kind === "table") await writeTable(`${output}/2/${safe(schema)}/${safe(name)}`, chunk, cols[`${schema}.${name}`], keys[`${schema}.${name}`]);
        else await write(`${output}/${{header: 1, footer: 3}[kind]}.sql`, chunk.join(""));
};

const walk = async (dir, parts = []) => {
    const entries = (await readdir(dir, {withFileTypes: true})).sort((a, b) => a.name < b.name ? -1 : 1);
    // directories holding files are table (or header/footer) transitions worth reporting
    if (entries.some(entry => !entry.isDirectory())) console.log(`table ${dir}`);
    // `0.sql` sorts before hash-named chunks so each table starts with its comment block
    for (const entry of entries)
        if (entry.isDirectory()) await walk(`${dir}/${entry.name}`, parts);
        else {
            log(`read ${dir}/${entry.name}`);
            const text = await Bun.file(`${dir}/${entry.name}`).text();
            // reverse the split-time formatting of INSERT chunks back to single-line statements
            parts.push(text.startsWith("INSERT ") ? unformat(text) + "\n" : text);
        }
    return parts;
};

const joinCommand = async (input, output) => write(output, (await walk(input)).join(""));

const [command, input, output] = Bun.argv.slice(2).filter(arg => arg !== "-v");

switch (true) {
    case command === "split" && Boolean(input && output):
        await splitCommand(input, output);
        break;
    case command === "join" && Boolean(input && output):
        await joinCommand(input, output);
        break;
    default:
        console.error(usage);
        process.exit(1);
}
