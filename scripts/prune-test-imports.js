import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

function collectFiles(dir) {
  const out = [];
  for (const ent of readdirSync(dir)) {
    const p = path.join(dir, ent);
    const st = statSync(p);
    if (st.isDirectory()) {
      out.push(...collectFiles(p));
    } else if (p.endsWith(".ts")) {
      out.push(p);
    }
  }
  return out;
}

function localName(spec) {
  const s = spec.trim();
  if (!s) {
    return null;
  }
  const asMatch = s.match(/^(.*?)\s+as\s+(.*)$/);
  if (asMatch) {
    return asMatch[2].trim();
  }
  return s;
}

function isUsed(name, body) {
  const r = new RegExp(`\\b${name.replace(/[$]/g, "\\$")}\\b`, "m");
  return r.test(body);
}

function pruneImports(filePath) {
  const src = readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
  const importRegex = /^import[\s\S]*?;\n?/gm;
  const imports = [];
  let match;
  while ((match = importRegex.exec(src))) {
    imports.push({ start: match.index, end: importRegex.lastIndex, text: match[0] });
  }

  if (imports.length === 0) {
    return;
  }

  const importEnd = imports[imports.length - 1].end;
  const body = src.slice(importEnd);

  let newImportText = "";
  for (const imp of imports) {
    const text = imp.text;

    // Side-effect import, keep as-is.
    if (/^import\s+["'][^"']+["']/.test(text.trim())) {
      newImportText += text;
      continue;
    }

    const fromMatch = text.match(/from\s+["'][^"']+["']/);
    if (!fromMatch) {
      continue;
    }

    let defaultName = null;
    const defaultMatch = text.match(/^import\s+(type\s+)?([A-Za-z_$][\w$]*)\s*(,|from)/m);
    if (defaultMatch) {
      defaultName = defaultMatch[2];
    }

    const namedMatch = text.match(/\{([\s\S]*?)\}/m);
    let named = [];
    if (namedMatch) {
      named = namedMatch[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }

    const keepDefault = defaultName ? isUsed(defaultName, body) : false;
    const keepNamed = named.filter((spec) => {
      const name = localName(spec);
      if (!name) {
        return false;
      }
      return isUsed(name, body);
    });

    if (!keepDefault && keepNamed.length === 0) {
      continue;
    }

    const fromPart = text.slice(text.indexOf("from"));
    const isType = /^import\s+type\b/.test(text.trim());

    const parts = [];
    if (keepDefault) {
      parts.push(defaultName);
    }
    if (keepNamed.length > 0) {
      parts.push(`{ ${keepNamed.join(", ")} }`);
    }

    const rebuilt = `import ${isType ? "type " : ""}${parts.join(", ")} ${fromPart.trim()}\n`;
    newImportText += rebuilt;
  }

  const out = `${newImportText}\n${body.replace(/^\n+/, "")}`;
  writeFileSync(filePath, out);
}

const targets = [path.join(root, "test/file-hash-cache"), path.join(root, "test/file-hash-cache-format")];

for (const dir of targets) {
  for (const file of collectFiles(dir)) {
    pruneImports(file);
  }
}

console.log("Pruned imports in split test files.");
