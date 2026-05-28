import { useCallback, useState } from 'react';

interface Props {
  onFile: (file: File) => void;
}

export default function DropZone({ onFile }: Props) {
  const [dragging, setDragging] = useState(false);

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files[0];
      if (file && (file.type === 'text/csv' || file.name.endsWith('.csv'))) {
        onFile(file);
      }
    },
    [onFile],
  );

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onFile(file);
    e.target.value = '';
  };

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      onClick={() => document.getElementById('csv-file-input')?.click()}
      className={`border-2 border-dashed rounded-xl p-16 text-center cursor-pointer transition-colors select-none ${
        dragging
          ? 'border-blue-500 bg-blue-50'
          : 'border-gray-300 hover:border-blue-400 hover:bg-gray-50'
      }`}
    >
      <div className="text-4xl mb-3">📂</div>
      <p className="text-gray-600 font-medium">Drag & drop a CSV file here</p>
      <p className="text-gray-400 text-sm mt-1">or click to browse</p>
      <input
        id="csv-file-input"
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={handleChange}
      />
    </div>
  );
}
