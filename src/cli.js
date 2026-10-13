#!/usr/bin/env bun
// pg-leaf — reversible splitting of PostgreSQL dumps into Git-friendly files

import {appendFile, mkdir, readdir, rm} from "node:fs/promises";
import {split, statements} from "./sql.js";

const usage = `Usage:
  pg-leaf split <dump.sql> <output-dir>
  pg-leaf join <output-dir> <dump.sql>`;

const safe = name => name.replaceAll(/[^\w.-]/g, "_");

const sha256 = text => new Bun.CryptoHasher("sha256").update(text).digest("hex");

const writeTable = async (dir, lines) => {
    await mkdir(dir, {recursive: true});
    const used = new Set();
    for (const {kind, text} of statements(lines)) {
        switch (kind) {
            case "insert": {
                const hash = sha256(text);
                let file = `${hash}.sql`;
                for (let n = 2; used.has(file); n++) file = `${hash}.${n}.sql`;
                used.add(file);
                await Bun.write(`${dir}/${file}`, text);
                break;
            }
            default:
                await appendFile(`${dir}/_.sql`, text);
        }
    }
};

const splitCommand = async (input, output) => {
    const chunks = split(await Bun.file(input).text());
    await rm(output, {recursive: true, force: true});
    // numbered chunks keep header → data → footer order under plain alphabetical sort
    for (const {kind, schema, name, lines} of chunks)
        if (kind === "table") await writeTable(`${output}/2/${safe(schema)}/${safe(name)}`, lines);
        else await Bun.write(`${output}/${{header: 1, footer: 3}[kind]}.sql`, lines.join(""));
};

const walk = async dir => {
    const parts = [];
    // "en" collation puts `_.sql` before hash-named chunks so each table starts with its comment block
    for (const entry of (await readdir(dir, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name, "en")))
        if (entry.isDirectory()) parts.push(...await walk(`${dir}/${entry.name}`));
        else parts.push(await Bun.file(`${dir}/${entry.name}`).text());
    return parts;
};

const joinCommand = async (input, output) => Bun.write(output, (await walk(input)).join(""));

const [command, input, output] = Bun.argv.slice(2);

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
