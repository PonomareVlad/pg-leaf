import { describe, expect, test } from "bun:test";
import { keyHash, parse, splitDump } from "../src/sql.js";

const dump = (rows) => `CREATE TABLE public.users (id integer PRIMARY KEY, name text);
${rows.map(([id, name]) => `INSERT INTO public.users (id, name) VALUES (${id}, '${name}');`).join("\n")}
CREATE INDEX users_name_idx ON public.users (name);
`;

describe("parse", () => {
  test("does not split on semicolons inside strings, comments, or dollar quotes", () => {
    const statements = parse("SELECT 'a;b'; /* ; /* nested ; */ */ SELECT $$c;d$$; -- ;\nSELECT E'e;\\';f';");
    expect(statements.map(({ tokens }) => tokens.at(-2).value)).toEqual(["'a;b'", "$$c;d$$", "E'e;\\';f'"]);
  });

  test("keeps COPY FROM stdin data intact", () => {
    const copy = "COPY public.items (id) FROM stdin;\n1\tvalue; ' -- text\n\\.\n";
    expect(parse(copy)[0].text).toBe(copy);
  });
});

describe("keyHash", () => {
  test("uses length-delimited serialization and distinguishes NULL from 'NULL'", () => {
    expect(keyHash(["ab", "c"])).not.toBe(keyHash(["a", "bc"]));
    expect(keyHash(["NULL"])).not.toBe(keyHash(["'NULL'"]));
  });
});

describe("splitDump", () => {
  test("keeps row paths and contents stable when input row order changes", () => {
    const first = splitDump(dump([[1, "Alice"], [2, "Bob"]]));
    const second = splitDump(dump([[2, "Bob"], [1, "Alice"]]));
    expect([...first.entries()].sort()).toEqual([...second.entries()].sort());
  });

  test("formats each row as a canonical multi-line INSERT", () => {
    const files = splitDump(dump([[1, "Alice"]]));
    const [path, contents] = [...files.entries()].find(([key]) => key.includes("/rows/"));
    expect(path).toMatch(/^10-data\/schemas\/public\/users\/rows\/[0-9a-f]{2}\/[0-9a-f]{64}\.sql$/);
    expect(contents).toBe('INSERT INTO "public"."users" (\n  "id",\n  "name"\n) VALUES (\n  1,\n  \'Alice\'\n);\n');
  });

  test("uses a primary key declared after the data in post-data", () => {
    const files = splitDump(
      "CREATE TABLE public.users (id integer);\n" +
      "INSERT INTO public.users (id) VALUES (7);\n" +
      "ALTER TABLE ONLY public.users ADD CONSTRAINT users_pkey PRIMARY KEY (id);\n",
    );
    expect([...files.keys()].some((path) => /\/rows\/[0-9a-f]{2}\//.test(path))).toBe(true);
  });

  test("falls back to distinct ordinal files when there is no unique key", () => {
    const files = splitDump("INSERT INTO public.logs (m) VALUES ('same');\nINSERT INTO public.logs (m) VALUES ('same');\n");
    const paths = [...files.keys()].sort();
    expect(paths).toEqual([
      "10-data/schemas/public/logs/rows/000000000001.sql",
      "10-data/schemas/public/logs/rows/000000000002.sql",
    ]);
  });

  test("rejects duplicate unique keys instead of overwriting a row", () => {
    expect(() => splitDump(dump([[1, "Alice"], [1, "Different"]]))).toThrow("Duplicate unique key");
  });

  test("rejects multi-row INSERT forms", () => {
    expect(() => splitDump("INSERT INTO t (id) VALUES (1), (2);")).toThrow("exactly one VALUES row");
  });

  test("supports DEFAULT VALUES and OVERRIDING SYSTEM VALUE", () => {
    const files = splitDump(
      "INSERT INTO public.generated DEFAULT VALUES;\n" +
      "INSERT INTO public.generated (id) OVERRIDING SYSTEM VALUE VALUES (9);\n",
    );
    const rows = [...files.values()];
    expect(rows).toContain('INSERT INTO "public"."generated" DEFAULT VALUES;\n');
    expect(rows).toContain('INSERT INTO "public"."generated" (\n  "id"\n) OVERRIDING SYSTEM VALUE VALUES (\n  9\n);\n');
  });

  test("routes statements into pre-data, data, and post-data phases", () => {
    const files = splitDump(dump([[1, "Alice"]]));
    expect(files.get("00-pre.sql")).toContain("CREATE TABLE");
    expect(files.get("20-post.sql")).toContain("CREATE INDEX");
  });

  test("encodes unsafe schema and table names deterministically", () => {
    const files = splitDump('INSERT INTO "Мой Проект"."User Data" ("id") VALUES (1);');
    const path = [...files.keys()].find((key) => key.includes("/rows/"));
    expect(path).toMatch(/^10-data\/schemas\/_-[0-9a-f]{8}\/user_data-[0-9a-f]{8}\/rows\//);
  });
});
