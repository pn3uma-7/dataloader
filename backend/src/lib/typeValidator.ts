export function validateColumnType(value: string, pgType: string): boolean {
  switch (pgType) {
    case 'INTEGER':   return /^-?\d+$/.test(value);
    case 'NUMERIC':   return /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(value);
    case 'DATE':      return /^\d{4}-\d{2}-\d{2}$/.test(value) && !isNaN(Date.parse(value));
    case 'TIMESTAMP': return !isNaN(Date.parse(value));
    case 'BOOLEAN':   return /^(true|false|1|0)$/i.test(value);
    case 'JSONB':     try { JSON.parse(value); return true; } catch { return false; }
    default:          return true; // VARCHAR — any value valid
  }
}
