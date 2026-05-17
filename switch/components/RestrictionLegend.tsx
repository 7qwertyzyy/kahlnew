export default function RestrictionLegend() {
  return (
    <div className="absolute bottom-8 left-4 z-10 bg-gray-900/90 backdrop-blur-sm border border-gray-700 rounded-lg p-3 text-xs text-gray-200 space-y-1.5 pointer-events-none">
      <p className="font-semibold text-gray-100 mb-1">Kartenlegende</p>
      <div className="flex items-center gap-2">
        <span className="w-4 h-1 rounded-full bg-blue-500 inline-block" />
        <span>Route</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="w-3 h-3 rounded-full bg-blue-500 border border-white inline-block" />
        <span>Baustellen-Punkt</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="w-4 h-1 rounded-full bg-orange-500 inline-block" />
        <span>Baustellen-Linie</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="w-4 h-1 rounded-full bg-red-500 inline-block" />
        <span>Schwertransportverbot</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="w-4 h-1 rounded-full bg-yellow-400 inline-block" />
        <span>Restriktion (passierbar)</span>
      </div>
    </div>
  );
}
