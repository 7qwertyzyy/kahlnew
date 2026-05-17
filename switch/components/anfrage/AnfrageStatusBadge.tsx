const STYLES: Record<string, string> = {
  neu: "bg-blue-900/50 text-blue-300 border-blue-700",
  in_bearbeitung: "bg-yellow-900/50 text-yellow-300 border-yellow-700",
  angebot_erstellt: "bg-purple-900/50 text-purple-300 border-purple-700",
  abgeschlossen: "bg-green-900/50 text-green-300 border-green-700",
  storniert: "bg-gray-800 text-gray-300 border-gray-600",
};

export default function AnfrageStatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center rounded border px-2 py-0.5 text-xs ${STYLES[status] ?? STYLES.neu}`}>
      {status.replace("_", " ")}
    </span>
  );
}
