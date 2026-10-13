import { describe, expect, test } from "bun:test";
import { keyHash, splitDump, splitStatements } from "../src/sql.js";

const dump = (rows) => `CREATE TABLE public.users (
  id integer PRIMARY KEY,
  name text
);
${rows.map(([id, name]) => `INSERT INTO public.users (id, name) VALUES (${id}, '${name}');`).join("\n")}
CREATE INDEX users_name_idx ON public.users (name);
`;

describe("SQL statement parsing", () => {
  test("does not split semicolons inside SQL strings, comments, or dollar quotes", () => {
    const statements = splitStatements(
      "SELECT 'a;b'; /* ; /* nested ; */ */ SELECT $$c;d$$; -- ;\nSELECT 3;",
    );
    expect(statements).toHaveLength(3);
    expect(statements[0]).toBe("SELECT 'a;b';");
    expect(statements[1]).toContain("SELECT $$c;d$$;");
    expect(statements[2]).toContain("SELECT 3;");
  });

  test("keeps a stable row path when input row order changes", () => {
    const first = splitDump(dump([[1, "Alice"], [2, "Bob"]]));
    const second = splitDump(dump([[2, "Bob"], [1, "Alice"]]));
    const paths = (files) => [...files.keys()].filter((path) => path.includes("/rows/")).sort();
    expect(paths(first)).toEqual(paths(second));
    for (const path of paths(first)) expect(first.get(path)).toBe(second.get(path));
  });

  test("uses length-delimited SHA-256 key values", () => {
    expect(keyHash(["ab", "c"])).not.toBe(keyHash(["a", "bc"]));
    expect(keyHash(["NULL"])).not.toBe(keyHash(["'NULL'"]));
  });

  test("falls back to distinct ordinal files when there is no unique key", () => {
    const files = splitDump("CREATE TABLE public.logs (message text);\nINSERT INTO public.logs (message) VALUES ('same');\nINSERT INTO public.logs (message) VALUES ('same');\n");
    const paths = [...files.keys()].filter((path) => path.includes("/rows/")).sort();
    expect(paths).toHaveLength(2);
    expect(paths[0]).toEndWith("000000000001.sql");
    expect(paths[1]).toEndWith("000000000002.sql");
  });

  test("rejects duplicate unique keys instead of overwriting a row", () => {
    expect(() => splitDump(dump([[1, "Alice"], [1, "Different"]]))).toThrow("Duplicate unique key");
  });

  test("preserves non-row SQL in the pre-data and post-data phases", () => {
    const files = splitDump(dump([[1, "Alice"]]));
    expect(files.has("00-pre.sql")).toBe(true);
    expect(files.has("20-post.sql")).toBe(true);
    expect(files.get("20-post.sql")).toContain("CREATE INDEX");
  });

  test("rejects INSERT forms that cannot be safely separated", () => {
    expect(() => splitDump("INSERT INTO t (id) VALUES (1), (2);")).toThrow("exactly one VALUES row");
  });

  test("supports default and identity override INSERT forms", () => {
    const files = splitDump(
      "CREATE TABLE public.generated (id integer PRIMARY KEY);\n" +
      "INSERT INTO public.generated DEFAULT VALUES;\n" +
      "INSERT INTO public.generated (id) OVERRIDING SYSTEM VALUE VALUES (9);\n",
    );
    const rows = [...files.entries()].filter(([path]) => path.includes("/rows/"));
    expect(rows).toHaveLength(2);
  });

  test("keeps COPY text data intact when records contain SQL punctuation", () => {
    const copy = "COPY public.items (id, value) FROM stdin;\n1\tvalue; ' -- text\n\\.\n";
    const files = splitDump(copy);
    expect(files.get("10-data/90-other.sql")).toContain(copy);
  });
});
