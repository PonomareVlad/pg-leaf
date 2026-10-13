import { describe, expect, test } from "bun:test";
import { keyHash, parse, splitDump, statements } from "../src/sql.js";

const dump = (rows) => `CREATE TABLE public.users (id integer PRIMARY KEY, name text);
${rows.map(([id, name]) => `INSERT INTO public.users (id, name) VALUES (${id}, '${name}');`).join("\n")}
CREATE INDEX users_name_idx ON public.users (name);
`;

describe("parse", () => {
  test("does not split on semicolons inside strings, comments, or dollar quotes", async () => {
    const parsed = await parse("SELECT 'a;b'; /* ; /* nested ; */ */ SELECT $$c;d$$; -- ;\nSELECT E'e;\\';f';");
    expect(parsed.map(({ tokens }) => tokens.at(-2).value)).toEqual(["'a;b'", "$$c;d$$", "E'e;\\';f'"]);
  });

  test("keeps COPY FROM stdin data intact", async () => {
    const copy = "COPY public.items (id) FROM stdin;\n1\tvalue; ' -- text\n\\.\n";
    expect((await parse(copy))[0].text).toBe(copy);
  });
});

describe("statements", () => {
  test("produces identical statements for whole and character-by-character input", async () => {
    const sql = await Bun.file(`${import.meta.dir}/../fixtures/dump.sql`).text();
    const whole = await parse(sql);
    const chunked = [];
    for await (const statement of statements((function* () { yield* sql; })())) chunked.push(statement);
    expect(chunked.map(({ text }) => text)).toEqual(whole.map(({ text }) => text));
  });
});

describe("keyHash", () => {
  test("uses length-delimited serialization and distinguishes NULL from 'NULL'", () => {
    expect(keyHash(["ab", "c"])).not.toBe(keyHash(["a", "bc"]));
    expect(keyHash(["NULL"])).not.toBe(keyHash(["'NULL'"]));
  });
});

describe("splitDump", () => {
  test("keeps row paths and contents stable when input row order changes", async () => {
    const first = await splitDump(dump([[1, "Alice"], [2, "Bob"]]));
    const second = await splitDump(dump([[2, "Bob"], [1, "Alice"]]));
    expect([...first.entries()].sort()).toEqual([...second.entries()].sort());
  });

  test("formats each row as a canonical multi-line INSERT", async () => {
    const files = await splitDump(dump([[1, "Alice"]]));
    const [path, contents] = [...files.entries()].find(([key]) => key.startsWith("data/public/"));
    expect(path).toMatch(/^data\/public\/users\/[0-9a-f]{2}\/[0-9a-f]{64}\.sql$/);
    expect(contents).toBe('INSERT INTO "public"."users" (\n  "id",\n  "name"\n) VALUES (\n  1,\n  \'Alice\'\n);\n');
  });

  test("uses a primary key declared after the data in post-data", async () => {
    const files = await splitDump(
      "CREATE TABLE public.users (id integer);\n" +
      "INSERT INTO public.users (id) VALUES (7);\n" +
      "ALTER TABLE ONLY public.users ADD CONSTRAINT users_pkey PRIMARY KEY (id);\n",
    );
    expect([...files.keys()].some((path) => /^data\/public\/users\//.test(path))).toBe(true);
  });

  test("suffixes identical keyless duplicates by probing", async () => {
    const files = await splitDump("INSERT INTO public.logs (m) VALUES ('same');\nINSERT INTO public.logs (m) VALUES ('same');\n");
    const paths = [...files.keys()].sort();
    expect(paths).toHaveLength(2);
    expect(paths[0]).toMatch(/^data\/public\/logs\/[0-9a-f]{2}\/[0-9a-f]{64}\.2\.sql$/);
    expect(paths[1]).toBe(paths[0].replace(".2.sql", ".sql"));
    expect(files.get(paths[0])).toBe(files.get(paths[1]));
  });

  test("rejects duplicate unique keys instead of overwriting a row", async () => {
    await expect(splitDump(dump([[1, "Alice"], [1, "Different"]]))).rejects.toThrow("Duplicate unique key");
  });

  test("rejects multi-row INSERT forms", async () => {
    await expect(splitDump("INSERT INTO t (id) VALUES (1), (2);")).rejects.toThrow("exactly one VALUES row");
  });

  test("supports DEFAULT VALUES and OVERRIDING SYSTEM VALUE", async () => {
    const files = await splitDump(
      "INSERT INTO public.generated DEFAULT VALUES;\n" +
      "INSERT INTO public.generated (id) OVERRIDING SYSTEM VALUE VALUES (9);\n",
    );
    const rows = [...files.values()];
    expect(rows).toContain('INSERT INTO "public"."generated" DEFAULT VALUES;\n');
    expect(rows).toContain('INSERT INTO "public"."generated" (\n  "id"\n) OVERRIDING SYSTEM VALUE VALUES (\n  9\n);\n');
  });

  test("routes statements into begin.sql, data/ and end.sql", async () => {
    const files = await splitDump(dump([[1, "Alice"]]));
    expect(files.get("begin.sql")).toContain("CREATE TABLE");
    expect(files.get("end.sql")).toContain("CREATE INDEX");
  });

  test("drops data segment comments and hashes other data statements into chunks", async () => {
    const files = await splitDump(
      "CREATE TABLE public.users (id integer PRIMARY KEY);\n" +
      "-- Data for Name: users\nINSERT INTO public.users (id) VALUES (1);\n" +
      "-- noise\nSELECT pg_catalog.setval('public.users_id_seq', 1, true);\n",
    );
    const chunk = [...files.keys()].find((path) => /^data\/[0-9a-f]{2}\/[0-9a-f]{64}\.sql$/.test(path));
    expect(files.get(chunk)).toBe("SELECT pg_catalog.setval('public.users_id_seq', 1, true);\n");
    expect([...files.values()].join("")).not.toContain("--");
  });

  test("keeps comments inline in pre- and post-data", async () => {
    const files = await splitDump("-- header\nCREATE TABLE public.t (id integer);\nINSERT INTO public.t (id) VALUES (1);\n-- footer\nCREATE INDEX i ON public.t (id);\n");
    expect(files.get("begin.sql")).toContain("-- header");
    expect(files.get("end.sql")).toContain("-- footer");
  });

  test("encodes unsafe schema and table names deterministically", async () => {
    const files = await splitDump('INSERT INTO "Мой Проект"."User Data" ("id") VALUES (1);');
    const path = [...files.keys()].find((key) => key.split("/").length === 5);
    expect(path).toMatch(/^data\/_-[0-9a-f]{8}\/user_data-[0-9a-f]{8}\//);
  });
});
