import {expect, test} from "bun:test";
import {mkdtemp, readdir, rm} from "node:fs/promises";
import {tmpdir} from "node:os";

const fixture = new URL("../fixtures/dump.sql", import.meta.url).pathname;
const cli = new URL("../src/cli.js", import.meta.url).pathname;

const run = (...args) => Bun.spawn(["bun", cli, ...args]).exited;

const sorted = sql => sql.split("\n").sort();

test("split writes one hash-named chunk per INSERT plus _.sql for the rest", async () => {
    const dir = await mkdtemp(`${tmpdir()}/pg-leaf-`);
    try {
        expect(await run("split", fixture, `${dir}/output`)).toBe(0);
        expect((await readdir(`${dir}/output`)).sort()).toEqual(["1.sql", "2", "3.sql"]);
        expect((await readdir(`${dir}/output/2/public`)).sort()).toEqual(["logs", "orders", "products", "users"]);

        const logs = (await readdir(`${dir}/output/2/public/logs`)).sort();
        expect(logs).toContain("_.sql");
        expect(logs.filter(file => /^[0-9a-f]{64}\.sql$/.test(file))).toHaveLength(2);
        expect(logs.filter(file => /^[0-9a-f]{64}\.2\.sql$/.test(file))).toHaveLength(1);
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
});

test("join output converges and keeps every line of the original dump", async () => {
    const dir = await mkdtemp(`${tmpdir()}/pg-leaf-`);
    try {
        await run("split", fixture, `${dir}/output`);
        await run("join", `${dir}/output`, `${dir}/first.sql`);
        await run("split", `${dir}/first.sql`, `${dir}/output`);
        await run("join", `${dir}/output`, `${dir}/second.sql`);

        const [dump, first, second] = await Promise.all(
            [fixture, `${dir}/first.sql`, `${dir}/second.sql`].map(path => Bun.file(path).text())
        );
        expect(second).toBe(first);
        expect(sorted(first)).toEqual(sorted(dump));
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
});

test("split clears a stale output directory", async () => {
    const dir = await mkdtemp(`${tmpdir()}/pg-leaf-`);
    try {
        await Bun.write(`${dir}/output/2/public/stale/stale.sql`, "stale");
        expect(await run("split", fixture, `${dir}/output`)).toBe(0);
        expect((await readdir(`${dir}/output/2/public`)).sort()).toEqual(["logs", "orders", "products", "users"]);
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
});

test("CLI prints usage and exits non-zero without arguments", async () => {
    expect(await run()).toBe(1);
});

test("chunk names stay stable when non-key columns change", async () => {
    const dir = await mkdtemp(`${tmpdir()}/pg-leaf-`);
    try {
        const modified = (await Bun.file(fixture).text())
            .replace("'Alice', 'alice@example.com'", "'Alicia', 'alicia@example.com'");
        await Bun.write(`${dir}/modified.sql`, modified);
        await run("split", fixture, `${dir}/before`);
        await run("split", `${dir}/modified.sql`, `${dir}/after`);
        expect((await readdir(`${dir}/after/2/public/users`)).sort())
            .toEqual((await readdir(`${dir}/before/2/public/users`)).sort());
        expect((await readdir(`${dir}/after/2/public/logs`)).sort())
            .toEqual((await readdir(`${dir}/before/2/public/logs`)).sort());
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
});
