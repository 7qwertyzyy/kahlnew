"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import type { TransportAnfrage } from "@/lib/types";

export default function CustomerReplyDraft({ anfrage }: { anfrage: TransportAnfrage }) {
  const [text, setText] = useState(anfrage.kundenantwort_entwurf || "");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  async function regenerate() {
    setLoading(true);
    try {
      const res = await api.regenerateReply(anfrage.id);
      setText(res.kundenantwort_entwurf);
    } finally {
      setLoading(false);
    }
  }

  async function copy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <section className="bg-gray-900 rounded-lg p-4 space-y-3">
      <h2 className="text-sm font-medium text-gray-300">Kundenantwort-Entwurf</h2>
      <textarea
        className="w-full min-h-80 bg-gray-950 border border-gray-700 rounded p-3 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <div className="flex gap-2">
        <button onClick={copy} className="bg-gray-700 hover:bg-gray-600 text-white text-sm px-3 py-2 rounded">
          {copied ? "Kopiert" : "In Zwischenablage kopieren"}
        </button>
        <button onClick={regenerate} disabled={loading} className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm px-3 py-2 rounded">
          {loading ? "Generiere..." : "Neu generieren"}
        </button>
      </div>
    </section>
  );
}
