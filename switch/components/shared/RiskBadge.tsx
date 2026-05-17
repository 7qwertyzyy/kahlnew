const RISK_STYLES: Record<string, string> = {
  niedrig: "bg-green-800 text-green-200",
  mittel: "bg-yellow-800 text-yellow-200",
  hoch: "bg-orange-800 text-orange-200",
  kritisch: "bg-red-800 text-red-200",
  "sehr kritisch": "bg-red-900 text-red-100 font-bold",
};

const RISK_ICONS: Record<string, string> = {
  niedrig: "●",
  mittel: "●",
  hoch: "●",
  kritisch: "●",
  "sehr kritisch": "●",
};

interface Props {
  level: string;
  size?: "sm" | "md";
}

export default function RiskBadge({ level, size = "md" }: Props) {
  const style = RISK_STYLES[level] ?? "bg-gray-700 text-gray-300";
  const icon = RISK_ICONS[level] ?? "●";
  const px = size === "sm" ? "px-1.5 py-0.5 text-xs" : "px-2 py-1 text-xs";
  return (
    <span className={`inline-flex items-center gap-1 rounded font-medium ${px} ${style}`}>
      {icon} {level}
    </span>
  );
}
