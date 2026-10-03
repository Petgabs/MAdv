// Split a SQL script into top-level statements, honouring $tag$ quoting and
// single-quoted literals (a naive split on ";" breaks function bodies).
export function splitStatements(sql) {
  const out = [];
  let buf = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'") {
      buf += ch; i++;
      while (i < sql.length) {
        if (sql[i] === "'") { buf += sql[i]; i++; if (sql[i] === "'") { buf += sql[i]; i++; } else break; }
        else { buf += sql[i]; i++; }
      }
      continue;
    }
    if (ch === '"') { buf += ch; i++; while (i < sql.length && sql[i] !== '"') { buf += sql[i]; i++; } buf += '"'; i++; continue; }
    if (ch === '-' && sql[i + 1] === '-') { while (i < sql.length && sql[i] !== '\n') { buf += sql[i]; i++; } continue; }
    if (ch === '$') {
      const m = sql.slice(i).match(/^\$[A-Za-z_0-9]*\$/);
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        if (end >= 0) { buf += sql.slice(i, end + tag.length); i = end + tag.length; continue; }
      }
    }
    if (ch === ';') { buf += ch; out.push(buf.trim()); buf = ''; i++; continue; }
    buf += ch; i++;
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter((s) => s.replace(/--[^\n]*/g, '').trim().length > 0);
}
