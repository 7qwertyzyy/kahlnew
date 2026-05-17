"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";

const INPUT = "w-full bg-gray-800 border border-gray-600 rounded px-2 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500";

export default function AnfrageInputForm() {
  const router = useRouter();
  const [tab, setTab] = useState<"formular" | "freitext" | "datei">("formular");
  const [loading, setLoading] = useState(false);
  const [phase, setPhase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [form, setForm] = useState<Record<string, string>>({ eingabe_typ: "formular", anzahl_fahrten: "1" });

  function update(key: string, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function submit() {
    setLoading(true);
    setError(null);
    try {
      setPhase("KI analysiert Anfrage...");
      let result;
      if (tab === "datei") {
        if (!file) throw new Error("Bitte eine Datei auswählen.");
        const body = new FormData();
        body.append("file", file);
        body.append("eingabe_typ", file.name.toLowerCase().endsWith(".pdf") ? "pdf" : "email");
        result = await api.createAnfrage(body);
      } else if (tab === "freitext") {
        result = await api.createAnfrage({ eingabe_typ: "freitext", eingabe_rohtext: text });
      } else {
        const numeric = ["laenge_m", "breite_m", "hoehe_m", "gewicht_t", "achslast_t", "anzahl_fahrten"];
        const payload: Record<string, string | number> = { eingabe_typ: "formular" };
        Object.entries(form).forEach(([key, value]) => {
          if (value !== "") payload[key] = numeric.includes(key) ? Number(value) : value;
        });
        result = await api.createAnfrage(payload);
      }
      setPhase("Suche ähnliche Genehmigungen...");
      setTimeout(() => setPhase("Erstelle Briefing..."), 250);
      router.push(`/anfrage/${result.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="bg-gray-900 rounded-lg p-5 space-y-5">
      <div className="flex gap-2 border-b border-gray-700 pb-3">
        {(["formular", "freitext", "datei"] as const).map((key) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-3 py-1.5 rounded text-sm ${tab === key ? "bg-blue-600 text-white" : "bg-gray-800 text-gray-300 hover:bg-gray-700"}`}
          >
            {key === "formular" ? "Formular" : key === "freitext" ? "Freitext/E-Mail" : "Datei-Upload"}
          </button>
        ))}
      </div>

      {tab === "formular" && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Firma"><input className={INPUT} value={form.kunde || ""} onChange={(e) => update("kunde", e.target.value)} /></Field>
          <Field label="Ansprechpartner"><input className={INPUT} value={form.ansprechpartner || ""} onChange={(e) => update("ansprechpartner", e.target.value)} /></Field>
          <Field label="E-Mail"><input className={INPUT} value={form.email || ""} onChange={(e) => update("email", e.target.value)} /></Field>
          <Field label="Telefon"><input className={INPUT} value={form.telefon || ""} onChange={(e) => update("telefon", e.target.value)} /></Field>
          <Field label="Startort"><input className={INPUT} value={form.startort || ""} onChange={(e) => update("startort", e.target.value)} /></Field>
          <Field label="Zielort"><input className={INPUT} value={form.zielort || ""} onChange={(e) => update("zielort", e.target.value)} /></Field>
          <Field label="Transportgut"><input className={INPUT} value={form.transportgut || ""} onChange={(e) => update("transportgut", e.target.value)} /></Field>
          <Field label="Fahrzeugtyp"><input className={INPUT} value={form.fahrzeugtyp || ""} onChange={(e) => update("fahrzeugtyp", e.target.value)} /></Field>
          {[
            ["laenge_m", "Länge (m)"],
            ["breite_m", "Breite (m)"],
            ["hoehe_m", "Höhe (m)"],
            ["gewicht_t", "Gewicht (t)"],
            ["achslast_t", "Achslast (t)"],
            ["anzahl_fahrten", "Fahrten"],
          ].map(([key, label]) => (
            <Field key={key} label={label}><input type="number" step="0.1" className={INPUT} value={form[key] || ""} onChange={(e) => update(key, e.target.value)} /></Field>
          ))}
          <Field label="Wunschdatum"><input type="date" className={INPUT} value={form.wunschdatum || ""} onChange={(e) => update("wunschdatum", e.target.value)} /></Field>
          <Field label="Angebotsfrist"><input type="date" className={INPUT} value={form.frist_angebot || ""} onChange={(e) => update("frist_angebot", e.target.value)} /></Field>
          <div className="md:col-span-2"><Field label="Besonderheiten"><input className={INPUT} value={form.besonderheiten || ""} onChange={(e) => update("besonderheiten", e.target.value)} /></Field></div>
        </div>
      )}

      {tab === "freitext" && (
        <textarea
          className="w-full min-h-56 bg-gray-800 border border-gray-600 rounded p-3 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Hier den Text der Kundenmail einfügen..."
        />
      )}

      {tab === "datei" && (
        <label className="block border border-dashed border-gray-600 rounded-lg p-8 text-center text-sm text-gray-300 cursor-pointer hover:border-blue-500">
          <input type="file" className="hidden" accept=".pdf,.eml,.txt,.msg" onChange={(event) => setFile(event.target.files?.[0] || null)} />
          {file ? file.name : "PDF oder E-Mail-Datei hier ablegen"}
          <div className="text-xs text-gray-500 mt-2">Unterstützt: .pdf, .eml, .txt, .msg</div>
        </label>
      )}

      {error && <p className="text-sm text-red-300">{error}</p>}
      {loading && <p className="text-sm text-blue-300">{phase}</p>}
      <button onClick={submit} disabled={loading} className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm px-4 py-2 rounded">
        {loading ? "Analysiere..." : "Anfrage analysieren"}
      </button>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs text-gray-500">{label}</span>
      {children}
    </label>
  );
}
