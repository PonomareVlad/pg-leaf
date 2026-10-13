import {expect, test} from "bun:test";
import {mkdtemp, readdir, rm} from "node:fs/promises";
import {tmpdir} from "node:os";

const fixture = new URL("../fixtures/dump.sql", import.meta.url).pathname;
const cli = new URL("../src/cli.js", import.meta.url).pathname;

const run = (...args) => Bun.spawn(["bun", cli, ...args]).exited;

test("split and join roundtrip through the CLI is lossless", async () => {
    const dir = await mkdtemp(`${tmpdir()}/pg-leaf-`);
    try {
        expect(await run("split", fixture, `${dir}/output`)).toBe(0);
        expect((await readdir(`${dir}/output`)).sort()).toEqual(["data", "footer.sql", "header.sql", "manifest.json"]);
        expect((await readdir(`${dir}/output/data`)).sort()).toEqual(["orders.sql", "products.sql", "users.sql"]);

        const {tables} = await Bun.file(`${dir}/output/manifest.json`).json();
        expect(tables).toEqual(["orders.sql", "products.sql", "users.sql"]);

        expect(await run("join", `${dir}/output`, `${dir}/restored.sql`)).toBe(0);
        expect(await Bun.file(`${dir}/restored.sql`).text()).toBe(await Bun.file(fixture).text());
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
});

test("CLI prints usage and exits non-zero without arguments", async () => {
    expect(await run()).toBe(1);
});
