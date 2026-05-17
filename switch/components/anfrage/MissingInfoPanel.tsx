export default function MissingInfoPanel({ items }: { items: string[] }) {
  return (
    <section className="bg-gray-900 rounded-lg p-4">
      <h2 className="text-sm font-medium text-gray-300 mb-3">Fehlende Informationen</h2>
      {items.length === 0 ? (
        <p className="text-sm text-green-300">Keine offensichtlichen Pflichtinformationen offen.</p>
      ) : (
        <ul className="space-y-1 text-sm text-red-200">
          {items.map((item) => (
            <li key={item}>- {item}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
