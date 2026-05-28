import { Transform } from 'stream';

/**
 * Parses one CSV line, trims whitespace from every field value, and re-serialises.
 * Handles RFC-4180 quoting (escaped quotes as "", quoted fields with commas).
 * Does NOT handle fields containing embedded newlines (not needed for flat file loads).
 */
function trimCsvLine(line: string): string {
  const out: string[] = [];
  let pos = 0;
  const len = line.length;

  while (pos < len) {
    if (line[pos] === '"') {
      // Quoted field — extract raw value, trim, re-quote only if necessary
      pos++; // skip opening quote
      let val = '';
      while (pos < len) {
        const ch = line[pos++];
        if (ch === '"') {
          if (pos < len && line[pos] === '"') { val += '"'; pos++; } // escaped ""
          else break; // closing quote
        } else {
          val += ch;
        }
      }
      if (pos < len && line[pos] === ',') pos++; // skip field separator
      const t = val.trim();
      // Re-quote only if the trimmed value contains a comma, quote, or newline
      out.push(/[,"\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t);
    } else {
      // Unquoted field — find next comma, trim the slice
      const comma = line.indexOf(',', pos);
      if (comma === -1) {
        out.push(line.slice(pos).trim());
        pos = len;
      } else {
        out.push(line.slice(pos, comma).trim());
        pos = comma + 1;
        if (pos === len) out.push(''); // trailing comma → empty last field
      }
    }
  }

  return out.join(',');
}

/**
 * A Transform stream that trims whitespace from every CSV cell value.
 * The header row is passed through unchanged.
 * Works line-by-line and buffers incomplete lines across chunk boundaries.
 */
export function createTrimmingTransform(): Transform {
  let headerDone = false;
  let leftover = '';

  return new Transform({
    transform(chunk: Buffer, _enc, callback) {
      const text = leftover + chunk.toString('utf8');
      const lines = text.split('\n');
      leftover = lines.pop() ?? ''; // keep the last (possibly incomplete) line

      for (const raw of lines) {
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw; // normalise CRLF
        if (!headerDone) {
          this.push(line + '\n'); // pass header unchanged
          headerDone = true;
        } else {
          this.push(trimCsvLine(line) + '\n');
        }
      }
      callback();
    },
    flush(callback) {
      if (leftover) {
        const line = leftover.endsWith('\r') ? leftover.slice(0, -1) : leftover;
        this.push(headerDone ? trimCsvLine(line) : line);
      }
      callback();
    },
  });
}
