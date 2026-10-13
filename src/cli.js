#!/usr/bin/env bun
// pg-leaf — reversible splitting of PostgreSQL dumps into Git-friendly files

import {readdir, rm} from "node:fs/promises";
import {split} from "./sql.js";

const usage = `Usage:
  pg-leaf split <dump.sql> <output-dir>
  pg-leaf join <output-dir> <dump.sql>`;

const safe = name => name.replaceAll(/[^\w.-]/g, "_");

// numbered chunks keep header → data → footer order under plain alphabetical sort
const path = ({kind, schema, name}) => kind === "table"
    ? `2/${safe(schema)}/${safe(name)}.sql`
    : `${{header: 1, footer: 3}[kind]}.sql`;

const splitCommand = async (input, output) => {
    const chunks = split(await Bun.file(input).text());
    await rm(output, {recursive: true, force: true});
    for (const chunk of chunks) await Bun.write(`${output}/${path(chunk)}`, chunk.lines.join(""));
};

const walk = async dir => {
    const parts = [];
    for (const entry of (await readdir(dir, {withFileTypes: true})).sort((a, b) => a.name < b.name ? -1 : 1))
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
