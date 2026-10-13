import { createHash } from "node:crypto";

export function splitStatements(sql) {
  const statements = [];
  let start = 0;
  let i = 0;
  let blockDepth = 0;
  let quote = null;
  let dollarQuote = null;
  let escapeString = false;

  while (i < sql.length) {
    const char = sql[i];
    const next = sql[i + 1];

    if (dollarQuote) {
      if (sql.startsWith(dollarQuote, i)) {
        i += dollarQuote.length;
        dollarQuote = null;
      } else {
        i++;
      }
      continue;
    }

    if (quote === "'") {
      if (escapeString && char === "\\") {
        i += Math.min(2, sql.length - i);
      } else if (char === "'" && next === "'") {
        i += 2;
      } else if (char === "'") {
        quote = null;
        i++;
      } else {
        i++;
      }
      continue;
    }

    if (quote === '"') {
      if (char === '"' && next === '"') {
        i += 2;
      } else if (char === '"') {
        quote = null;
        i++;
      } else {
        i++;
      }
      continue;
    }

    if (blockDepth > 0) {
      if (char === "/" && next === "*") {
        blockDepth++;
        i += 2;
      } else if (char === "*" && next === "/") {
        blockDepth--;
        i += 2;
      } else {
        i++;
      }
      continue;
    }

    if (char === "-" && next === "-") {
      const newline = sql.indexOf("\n", i + 2);
      i = newline === -1 ? sql.length : newline + 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockDepth = 1;
      i += 2;
      continue;
    }
    if (char === "'") {
      const prefix = sql[i - 1];
      const beforePrefix = sql[i - 2];
      escapeString =
        (prefix === "e" || prefix === "E") &&
        (beforePrefix === undefined || !/[A-Za-z0-9_$]/.test(beforePrefix));
      quote = "'";
      i++;
      continue;
    }
    if (char === '"') {
      quote = '"';
      i++;
      continue;
    }
    if (char === "$") {
      const match = sql.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if (match) {
        dollarQuote = match[0];
        i += dollarQuote.length;
        continue;
      }
    }
    if (char === ";") {
      const candidate = sql.slice(start, i + 1);
      const withoutLeadingComments = candidate.replace(
        /^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/,
        "",
      );
      if (/^COPY\b[\s\S]*\bFROM\s+stdin\s*;\s*$/i.test(withoutLeadingComments)) {
        const terminator = /(?:^|\r?\n)\\\.[ \t]*(?:\r?\n|$)/g;
        terminator.lastIndex = i + 1;
        const match = terminator.exec(sql);
        if (!match) throw new Error("Unterminated COPY FROM stdin block");
        const end = terminator.lastIndex;
        statements.push(sql.slice(start, end));
        start = end;
        i = end - 1;
      } else {
        statements.push(candidate);
        start = i + 1;
      }
    }
    i++;
  }

  if (start < sql.length) statements.push(sql.slice(start));
  return statements;
}

function tokenize(sql) {
  const tokens = [];
  let i = 0;

  while (i < sql.length) {
    const char = sql[i];
    const next = sql[i + 1];
    if (/\s/.test(char)) {
      i++;
      continue;
    }
    if (char === "-" && next === "-") {
      const newline = sql.indexOf("\n", i + 2);
      i = newline === -1 ? sql.length : newline + 1;
      continue;
    }
    if (char === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      continue;
    }

    const start = i;
    if (char === '"') {
      i++;
      let value = "";
      while (i < sql.length) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          value += '"';
          i += 2;
        } else if (sql[i] === '"') {
          i++;
          break;
        } else {
          value += sql[i++];
        }
      }
      tokens.push({ type: "identifier", value, start, end: i });
      continue;
    }
    if (char === "'") {
      i++;
      const escapeString =
        (sql[start - 1] === "e" || sql[start - 1] === "E") &&
        (start < 2 || !/[A-Za-z0-9_$]/.test(sql[start - 2]));
      while (i < sql.length) {
        if (escapeString && sql[i] === "\\") {
          i += Math.min(2, sql.length - i);
        } else if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
        } else if (sql[i] === "'") {
          i++;
          break;
        } else {
          i++;
        }
      }
      tokens.push({ type: "literal", value: sql.slice(start, i), start, end: i });
      continue;
    }
    if (char === "$") {
      const match = sql.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if (match) {
        const delimiter = match[0];
        const close = sql.indexOf(delimiter, i + delimiter.length);
        i = close === -1 ? sql.length : close + delimiter.length;
        tokens.push({ type: "literal", value: sql.slice(start, i), start, end: i });
        continue;
      }
    }
    if (/[A-Za-z_$]/.test(char)) {
      i++;
      while (i < sql.length && /[A-Za-z0-9_$]/.test(sql[i])) i++;
      tokens.push({ type: "word", value: sql.slice(start, i), start, end: i });
      continue;
    }
    if (/[0-9]/.test(char)) {
      i++;
      while (i < sql.length && /[A-Za-z0-9_.+-]/.test(sql[i])) i++;
      tokens.push({ type: "number", value: sql.slice(start, i), start, end: i });
      continue;
    }
    i++;
    tokens.push({ type: "symbol", value: char, start, end: i });
  }
  return tokens;
}

const identifier = (token) =>
  token?.type === "identifier" || token?.type === "word";
const upper = (token) => token?.value?.toUpperCase();

function readQualifiedName(tokens, start) {
  if (!identifier(tokens[start])) return null;
  const parts = [tokens[start].value];
  let index = start + 1;
  while (tokens[index]?.value === "." && identifier(tokens[index + 1])) {
    parts.push(tokens[index + 1].value);
    index += 2;
  }
  if (parts.length === 1) parts.unshift("public");
  return { schema: parts.at(-2), table: parts.at(-1), key: `${parts.at(-2)}\0${parts.at(-1)}`, next: index };
}

function findClose(tokens, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < tokens.length; i++) {
    if (tokens[i].value === "(") depth++;
    if (tokens[i].value === ")" && --depth === 0) return i;
  }
  return -1;
}

function splitTopLevel(tokens, start, end) {
  const parts = [];
  let depth = 0;
  let partStart = start;
  for (let i = start; i < end; i++) {
    if (tokens[i].value === "(") depth++;
    else if (tokens[i].value === ")") depth--;
    else if (tokens[i].value === "," && depth === 0) {
      parts.push(tokens.slice(partStart, i));
      partStart = i + 1;
    }
  }
  if (partStart < end) parts.push(tokens.slice(partStart, end));
  return parts;
}

function parseColumnList(tokens, openIndex) {
  const close = findClose(tokens, openIndex);
  if (close === -1) return null;
  const columns = splitTopLevel(tokens, openIndex + 1, close).map((part) =>
    part.length === 1 && identifier(part[0]) ? part[0].value : null,
  );
  return columns.every(Boolean) ? { columns, close } : null;
}

function parseCreateTable(tokens, tables) {
  if (upper(tokens[0]) !== "CREATE") return;
  let index = 1;
  if (upper(tokens[index]) === "UNLOGGED" || upper(tokens[index]) === "TEMP" || upper(tokens[index]) === "TEMPORARY") index++;
  if (upper(tokens[index]) !== "TABLE") return;
  index++;
  if (upper(tokens[index]) === "IF") index += 3;
  const name = readQualifiedName(tokens, index);
  if (!name || tokens[name.next]?.value !== "(") return;
  const close = findClose(tokens, name.next);
  if (close === -1) return;

  const table = tables.get(name.key) ?? { primary: null, unique: [], notNull: new Set() };
  for (const part of splitTopLevel(tokens, name.next + 1, close)) {
    let cursor = 0;
    if (upper(part[cursor]) === "CONSTRAINT") cursor += 2;
    if (upper(part[cursor]) === "PRIMARY" && upper(part[cursor + 1]) === "KEY") {
      const key = parseColumnList(part, cursor + 2);
      if (key) table.primary = key.columns;
      continue;
    }
    if (upper(part[cursor]) === "UNIQUE") {
      let after = cursor + 1;
      const nullsNotDistinct = upper(part[after]) === "NULLS" && upper(part[after + 1]) === "NOT";
      if (nullsNotDistinct) after += 3;
      const key = parseColumnList(part, after);
      if (key) table.unique.push({ columns: key.columns, nullsNotDistinct });
      continue;
    }
    const column = part[cursor];
    if (!identifier(column)) continue;
    const rest = part.slice(cursor + 1).map(upper);
    if (rest.includes("NOT") && rest.includes("NULL")) table.notNull.add(column.value);
    if (rest.includes("PRIMARY") && rest.includes("KEY")) table.primary = [column.value];
    if (rest.includes("UNIQUE")) table.unique.push({ columns: [column.value], nullsNotDistinct: false });
  }
  tables.set(name.key, table);
}

function parseAlterTable(tokens, tables) {
  if (upper(tokens[0]) !== "ALTER" || upper(tokens[1]) !== "TABLE") return;
  let index = 2;
  if (upper(tokens[index]) === "ONLY") index++;
  const name = readQualifiedName(tokens, index);
  if (!name) return;
  index = name.next;
  if (upper(tokens[index]) !== "ADD") return;
  index++;
  if (upper(tokens[index]) === "CONSTRAINT") index += 2;
  const kind = upper(tokens[index]);
  if (kind !== "PRIMARY" && kind !== "UNIQUE") return;
  if (kind === "PRIMARY" && upper(tokens[index + 1]) !== "KEY") return;
  const nullsNotDistinct = kind === "UNIQUE" &&
    tokens.slice(index + 1, index + 4).some((token, i, all) =>
      upper(token) === "NULLS" && upper(all[i + 1]) === "NOT" && upper(all[i + 2]) === "DISTINCT",
    );
  let open = index + (kind === "PRIMARY" ? 2 : 1);
  while (open < tokens.length && tokens[open].value !== "(" && upper(tokens[open]) !== "USING") open++;
  const key = parseColumnList(tokens, open);
  if (!key) return;
  const table = tables.get(name.key) ?? { primary: null, unique: [], notNull: new Set() };
  if (kind === "PRIMARY") {
    table.primary = key.columns;
    for (const column of key.columns) table.notNull.add(column);
  } else {
    table.unique.push({ columns: key.columns, nullsNotDistinct });
  }
  tables.set(name.key, table);
}

function parseUniqueIndex(tokens, tables) {
  if (upper(tokens[0]) !== "CREATE") return;
  let index = 1;
  if (upper(tokens[index]) === "UNIQUE") index++;
  else return;
  if (upper(tokens[index]) !== "INDEX") return;
  while (index < tokens.length && upper(tokens[index]) !== "ON") index++;
  if (index === tokens.length) return;
  index++;
  if (upper(tokens[index]) === "ONLY") index++;
  const name = readQualifiedName(tokens, index);
  if (!name) return;
  index = name.next;
  while (index < tokens.length && tokens[index].value !== "(") index++;
  const key = parseColumnList(tokens, index);
  if (!key) return;
  const whereIndex = tokens.findIndex((token, i) => i > key.close && upper(token) === "WHERE");
  if (whereIndex !== -1) return;
  const nullsNotDistinct = tokens.slice(key.close + 1).some((token, i, all) =>
    upper(token) === "NULLS" && upper(all[i + 1]) === "NOT" && upper(all[i + 2]) === "DISTINCT",
  );
  const table = tables.get(name.key) ?? { primary: null, unique: [], notNull: new Set() };
  table.unique.push({ columns: key.columns, nullsNotDistinct });
  tables.set(name.key, table);
}

function selectKey(table) {
  if (!table) return null;
  if (table.primary?.length) return table.primary;
  const candidates = table.unique
    .filter(({ columns, nullsNotDistinct }) =>
      nullsNotDistinct || columns.every((column) => table.notNull.has(column)),
    )
    .map(({ columns }) => columns)
    .sort((a, b) => compareBytes(a.join("\0"), b.join("\0")));
  return candidates[0] ?? null;
}

function compareBytes(a, b) {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function parseInsert(statement, tokens) {
  let index = 1;
  if (upper(tokens[index]) === "INTO") index++;
  const table = readQualifiedName(tokens, index);
  if (!table) throw new Error("Unsupported INSERT target");
  index = table.next;
  if (upper(tokens[index]) === "DEFAULT" && upper(tokens[index + 1]) === "VALUES") {
    return { table, columns: [], values: [] };
  }
  if (tokens[index]?.value !== "(") throw new Error("INSERT must specify its column list");
  const columnsResult = parseColumnList(tokens, index);
  if (!columnsResult) throw new Error("Unsupported INSERT column list");
  index = columnsResult.close + 1;
  if (upper(tokens[index]) === "OVERRIDING") {
    if (upper(tokens[index + 1]) !== "SYSTEM" && upper(tokens[index + 1]) !== "USER") {
      throw new Error("Unsupported INSERT OVERRIDING clause");
    }
    if (upper(tokens[index + 2]) !== "VALUE") throw new Error("Unsupported INSERT OVERRIDING clause");
    index += 3;
  }
  if (upper(tokens[index]) !== "VALUES") throw new Error("INSERT must use VALUES");
  index++;
  if (tokens[index]?.value !== "(") throw new Error("INSERT must contain one VALUES row");
  const close = findClose(tokens, index);
  if (close === -1) throw new Error("Unclosed INSERT VALUES row");
  const valueParts = splitTopLevel(tokens, index + 1, close);
  if (close + 1 < tokens.length && tokens[close + 1].value === ",") {
    throw new Error("INSERT must contain exactly one VALUES row");
  }
  if (valueParts.length !== columnsResult.columns.length) {
    throw new Error("INSERT column and value counts do not match");
  }
  const values = valueParts.map((part) => {
    if (!part.length) throw new Error("Empty INSERT value");
    return statement.slice(part[0].start, part.at(-1).end);
  });
  return { table, columns: columnsResult.columns, values };
}

function isInsert(tokens) {
  return upper(tokens[0]) === "INSERT";
}

function isPostData(tokens) {
  const first = upper(tokens[0]);
  if (first === "CREATE" && ["INDEX", "TRIGGER", "RULE", "POLICY"].includes(upper(tokens[1]))) return true;
  if (first !== "ALTER" || upper(tokens[1]) !== "TABLE") return false;
  const rest = tokens.map(upper);
  return rest.includes("CONSTRAINT") || rest.includes("FOREIGN") || rest.includes("VALIDATE");
}

function isDataStatement(tokens) {
  if (upper(tokens[0]) === "COPY") return true;
  return upper(tokens[0]) === "SELECT" &&
    (tokens.some((token) => token.value.toLowerCase().includes("setval")) ||
      tokens.some((token) => token.value.toLowerCase().includes("lo_")));
}

function componentName(value) {
  return `x-${Buffer.from(value, "utf8").toString("hex")}`;
}

function serializeKey(values) {
  const chunks = [Buffer.from([values.length >> 8, values.length & 0xff])];
  for (const value of values) {
    const isNull = /^NULL$/i.test(value.trim());
    const bytes = Buffer.from(value, "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(isNull ? 0xffffffff : bytes.length);
    chunks.push(length, ...(isNull ? [] : [bytes]));
  }
  return Buffer.concat(chunks);
}

export function keyHash(values) {
  return createHash("sha256").update(serializeKey(values)).digest("hex");
}

function splitPath({ schema, table }, hashOrIndex) {
  const prefix = `10-data/schemas/${componentName(schema)}/${componentName(table)}/rows/`;
  if (typeof hashOrIndex === "number") return `${prefix}${String(hashOrIndex).padStart(12, "0")}.sql`;
  return `${prefix}${hashOrIndex.slice(0, 2)}/${hashOrIndex}.sql`;
}

export function splitDump(sql) {
  const statements = splitStatements(sql);
  const tables = new Map();
  const parsed = statements.map((statement) => {
    const tokens = tokenize(statement);
    parseCreateTable(tokens, tables);
    parseAlterTable(tokens, tables);
    parseUniqueIndex(tokens, tables);
    return { statement, tokens };
  });

  const files = new Map();
  const dataOther = [];
  const pre = [];
  const post = [];
  const counts = new Map();
  const seenKeys = new Map();
  let dataStarted = false;
  let postStarted = false;

  for (const { statement, tokens } of parsed) {
    if (!tokens.length) {
      (postStarted ? post : dataStarted ? dataOther : pre).push(statement);
      continue;
    }
    if (isInsert(tokens)) {
      dataStarted = true;
      const row = parseInsert(statement, tokens);
      const metadata = tables.get(row.table.key);
      const keyColumns = selectKey(metadata);
      let path;
      if (keyColumns && keyColumns.every((column) => row.columns.includes(column))) {
        const indexes = keyColumns.map((column) => row.columns.indexOf(column));
        const keyValues = indexes.map((index) => row.values[index]);
        const keyId = keyHash(keyValues);
        path = splitPath(row.table, keyId);
        const previous = seenKeys.get(path);
        const encoded = serializeKey(keyValues);
        if (previous && !previous.equals(encoded)) throw new Error(`SHA-256 collision at ${path}`);
        if (previous) throw new Error(`Duplicate unique key in ${row.table.schema}.${row.table.table}`);
        seenKeys.set(path, encoded);
      } else {
        const count = counts.get(row.table.key) ?? 0;
        counts.set(row.table.key, count + 1);
        path = splitPath(row.table, count + 1);
      }
      if (files.has(path)) throw new Error(`Duplicate output path: ${path}`);
      files.set(path, statement);
      continue;
    }

    if (isPostData(tokens)) {
      postStarted = true;
      post.push(statement);
    } else if (isDataStatement(tokens)) {
      dataStarted = true;
      dataOther.push(statement);
    } else if (postStarted) {
      post.push(statement);
    } else if (dataStarted) {
      dataOther.push(statement);
    } else {
      pre.push(statement);
    }
  }

  if (pre.some((part) => part.length)) files.set("00-pre.sql", pre.join("\n"));
  if (dataOther.some((part) => part.length)) files.set("10-data/90-other.sql", dataOther.join("\n"));
  if (post.some((part) => part.length)) files.set("20-post.sql", post.join("\n"));
  return files;
}
