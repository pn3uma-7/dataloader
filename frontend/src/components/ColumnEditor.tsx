import type { Column, ColumnType } from '../types';

const TYPE_OPTIONS: { label: string; value: ColumnType }[] = [
  { label: 'Text', value: 'VARCHAR' },
  { label: 'Integer', value: 'INTEGER' },
  { label: 'Decimal', value: 'NUMERIC' },
  { label: 'True / False', value: 'BOOLEAN' },
  { label: 'Date', value: 'DATE' },
  { label: 'Date & Time', value: 'TIMESTAMP' },
  { label: 'JSON', value: 'JSONB' },
];

interface Props {
  columns: Column[];
  onChange: (columns: Column[]) => void;
  readonlyNames?: boolean;
}

export default function ColumnEditor({ columns, onChange, readonlyNames }: Props) {
  const update = (i: number, patch: Partial<Column>) => {
    onChange(columns.map((col, idx) => (idx === i ? { ...col, ...patch } : col)));
  };

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200">
      <table className="w-full text-sm">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-4 py-3 text-left font-medium text-gray-600">Column</th>
            <th className="px-4 py-3 text-left font-medium text-gray-600">Type</th>
            <th className="px-4 py-3 text-center font-medium text-gray-600">Primary Key</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {columns.map((col, i) => (
            <tr key={i} className="hover:bg-gray-50 transition-colors">
              <td className="px-4 py-2">
                {readonlyNames ? (
                  <span className="font-mono text-gray-800">{col.name}</span>
                ) : (
                  <input
                    value={col.name}
                    onChange={(e) => update(i, { name: e.target.value })}
                    className="border border-gray-300 rounded px-2 py-1 font-mono text-sm w-full focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                )}
              </td>
              <td className="px-4 py-2">
                <select
                  value={col.type}
                  onChange={(e) => update(i, { type: e.target.value as ColumnType })}
                  className="border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {TYPE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </td>
              <td className="px-4 py-2 text-center">
                <input
                  type="checkbox"
                  checked={col.primary_key}
                  onChange={(e) => update(i, { primary_key: e.target.checked })}
                  className="w-4 h-4 accent-blue-600"
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
