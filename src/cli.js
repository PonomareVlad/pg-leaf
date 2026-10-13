#!/usr/bin/env bun
// pg-leaf — reversible splitting of PostgreSQL dumps into Git-friendly files

import {split} from "./sql.js";

const usage = `Usage:
  pg-leaf split <dump.sql> <output-dir>
  pg-leaf join <output-dir> <dump.sql>`;

const safe = name => name.replaceAll(/[^\w.-]/g, "_");

const exists = path => Bun.file(path).exists();

const splitCommand = async (input, output) => {
    const chunks = split(await Bun.file(input).text());
    const tables = [];
    for (const {kind, name, lines} of chunks) {
        switch (kind) {
            case "table": {
                let file = `${safe(name)}.sql`;
                for (let n = 2; tables.includes(file); n++) file = `${safe(name)}.${n}.sql`;
                tables.push(file);
                await Bun.write(`${output}/data/${file}`, lines.join(""));
                break;
            }
            default:
                await Bun.write(`${output}/${kind}.sql`, lines.join(""));
        }
    }
    await Bun.write(`${output}/manifest.json`, JSON.stringify({tables}, null, 2) + "\n");
};

const joinCommand = async (input, output) => {
    const {tables} = await Bun.file(`${input}/manifest.json`).json();
    const parts = [
        `${input}/header.sql`,
        ...tables.map(file => `${input}/data/${file}`),
        `${input}/footer.sql`
    ];
    const chunks = [];
    for (const part of parts) if (await exists(part)) chunks.push(await Bun.file(part).text());
    await Bun.write(output, chunks.join(""));
};

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
