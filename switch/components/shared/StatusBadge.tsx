const STATUS_STYLES: Record<string, string> = {
  needs_review: "bg-yellow-800 text-yellow-200",
  verified: "bg-green-800 text-green-200",
  error: "bg-red-800 text-red-200",
};

const STATUS_LABELS: Record<string, string> = {
  needs_review: "Zu prüfen",
  verified: "Geprüft",
  error: "Fehler",
};

interface Props {
  status: string;
  size?: "sm" | "md";
}

export default function StatusBadge({ status, size = "md" }: Props) {
  const style = STATUS_STYLES[status] ?? "bg-gray-700 text-gray-300";
  const label = STATUS_LABELS[status] ?? status;
  const px = size === "sm" ? "px-1.5 py-0.5 text-xs" : "px-2 py-1 text-xs";
  return (
    <span className={`inline-block rounded font-medium ${px} ${style}`}>
      {label}
    </span>
  );
}
