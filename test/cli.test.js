import {expect, test} from "bun:test";
import {mkdtemp, readdir, rm} from "node:fs/promises";
import {tmpdir} from "node:os";

const fixture = new URL("../fixtures/dump.sql", import.meta.url).pathname;
const cli = new URL("../src/cli.js", import.meta.url).pathname;

const run = (...args) => Bun.spawn(["bun", cli, ...args]).exited;

const sorted = sql => sql.split("\n").sort();

test("join preserves alphabetical order across many nested chunks", async () => {
    const dir = await mkdtemp(`${tmpdir()}/pg-leaf-`);
    const count = 2048;
    try {
        await Bun.write(`${dir}/output/3.sql`, "-- footer\n");
        for (let i = count - 1; i >= 0; i--)
            await Bun.write(`${dir}/output/2/public/users/${String(i).padStart(4, "0")}.sql`, `-- chunk ${i}\n`);
        await Bun.write(`${dir}/output/2/public/z/0.sql`, "-- last table\n");
        await Bun.write(`${dir}/output/1.sql`, "-- header\n");

        expect(await run("join", `${dir}/output`, `${dir}/restored.sql`)).toBe(0);
        const expected = "-- header\n"
            + Array.from({length: count}, (_, i) => `-- chunk ${i}\n`).join("")
            + "-- last table\n-- footer\n";
        expect(await Bun.file(`${dir}/restored.sql`).text()).toBe(expected);
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
});

test("split writes one hash-named chunk per INSERT plus 0.sql for the rest", async () => {
    const dir = await mkdtemp(`${tmpdir()}/pg-leaf-`);
    try {
        expect(await run("split", fixture, `${dir}/output`)).toBe(0);
        expect((await readdir(`${dir}/output`)).sort()).toEqual(["1.sql", "2", "3.sql"]);
        expect((await readdir(`${dir}/output/2/public`)).sort()).toEqual(["logs", "orders", "products", "users"]);

        const logs = (await readdir(`${dir}/output/2/public/logs`)).sort();
        expect(logs).toContain("0.sql");
        expect(logs.filter(file => /^[0-9a-f]{64}\.sql$/.test(file))).toHaveLength(3);
        expect(logs.filter(file => /^[0-9a-f]{64}\.2\.sql$/.test(file))).toHaveLength(1);
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
});

test("INSERT chunks are formatted on split and restored to single-line statements on join", async () => {
    const dir = await mkdtemp(`${tmpdir()}/pg-leaf-`);
    try {
        await run("split", fixture, `${dir}/output`);
        const files = await readdir(`${dir}/output/2/public/users`);
        const [chunk] = files.filter(file => file !== "0.sql");
        expect(await Bun.file(`${dir}/output/2/public/users/${chunk}`).text()).toStartWith("INSERT INTO\n");

        await run("join", `${dir}/output`, `${dir}/restored.sql`);
        const restored = await Bun.file(`${dir}/restored.sql`).text();
        expect(restored).toContain("INSERT INTO public.users VALUES (1, 'Alice', 'alice@example.com');\n");
        expect(restored).toContain("INSERT INTO public.logs VALUES ('first line;\nsecond line');\n");
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

test("table names with unsupported characters are percent-encoded without collisions", async () => {
    const dir = await mkdtemp(`${tmpdir()}/pg-leaf-`);
    try {
        const modified = (await Bun.file(fixture).text())
            .replaceAll("public.logs", 'public."lo/gs"')
            .replaceAll("Name: logs;", "Name: lo/gs;")
            .replaceAll("public.orders", 'public."😀"')
            .replaceAll("Name: orders;", "Name: 😀;")
            .replaceAll("public.products", 'public."😁"')
            .replaceAll("Name: products;", "Name: 😁;");
        await Bun.write(`${dir}/modified.sql`, modified);
        await run("split", `${dir}/modified.sql`, `${dir}/output`);
        // distinct astral names encode to distinct directories (no surrogate-collapse collisions)
        expect((await readdir(`${dir}/output/2/public`)).sort())
            .toEqual(["%F0%9F%98%80", "%F0%9F%98%81", "lo%2Fgs", "users"]);
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
});

test("rows fall back to full-INSERT hashes when a key column cannot be mapped", async () => {
    const dir = await mkdtemp(`${tmpdir()}/pg-leaf-`);
    try {
        const modified = (await Bun.file(fixture).text())
            .replace("ADD CONSTRAINT users_pkey PRIMARY KEY (id);", "ADD CONSTRAINT users_pkey PRIMARY KEY (missing);");
        await Bun.write(`${dir}/modified.sql`, modified);
        await run("split", `${dir}/modified.sql`, `${dir}/output`);
        const users = (await readdir(`${dir}/output/2/public/users`)).sort();
        // every row keeps a distinct full-text hash instead of sharing one omitted-key identity
        expect(users.filter(file => /^[0-9a-f]{64}\.sql$/.test(file))).toHaveLength(3);
        expect(users.filter(file => /\.\d+\.sql$/.test(file))).toHaveLength(0);
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
});
