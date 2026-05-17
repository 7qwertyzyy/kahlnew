import AnfrageInputForm from "@/components/anfrage/AnfrageInputForm";

export default function NeueAnfragePage() {
  return (
    <div className="h-full overflow-y-auto p-6 space-y-6">
      <h1 className="text-xl font-semibold text-white">Neue Transportanfrage</h1>
      <AnfrageInputForm />
    </div>
  );
}
