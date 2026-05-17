"""
KI-Extraktion: überträgt die bewährte Logik aus dem Streamlit-MVP, ergänzt um neue Felder.
"""
import json
import os
import re
import urllib.request
import urllib.error
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / ".env", override=True)

AI_PROVIDER       = os.getenv("AI_PROVIDER", "anthropic")
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
OPENAI_API_KEY    = os.getenv("OPENAI_API_KEY", "")
ANTHROPIC_MODEL   = os.getenv("ANTHROPIC_MODEL", "claude-opus-4-7")
OPENAI_MODEL      = os.getenv("OPENAI_MODEL", "gpt-4o")
AZURE_OPENAI_API_KEY  = os.getenv("AZURE_OPENAI_API_KEY", "")
AZURE_OPENAI_ENDPOINT = os.getenv("AZURE_OPENAI_ENDPOINT", "")
AZURE_OPENAI_DEPLOY   = os.getenv("AZURE_OPENAI_DEPLOYMENT", "")
AZURE_OPENAI_VERSION  = os.getenv("AZURE_OPENAI_API_VERSION", "2024-08-01-preview")
OLLAMA_BASE_URL   = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434/v1")
OLLAMA_MODEL      = os.getenv("OLLAMA_MODEL", "qwen2.5:14b")
MISTRAL_API_KEY   = os.getenv("MISTRAL_API_KEY", "")
MISTRAL_MODEL     = os.getenv("MISTRAL_MODEL", "mistral-large-latest")

EXTRACTION_PROMPT = """You are extracting structured data from a German heavy transport permit (Schwertransportgenehmigung).

Return ONLY valid JSON — no explanation, no markdown fences.

Rules:
- Do NOT hallucinate or guess. If a field is unclear, return null (or [] for arrays).
- Extract dimensions in meters. Extract weight in tons.
- confidence: 0.0–1.0 reflecting how complete the extraction is.
- status must always be "needs_review".
- begleitfahrzeug_erforderlich: true if escort vehicle is required.
- polizei_erforderlich: true if police escort is required.
- nachtfahrt_erforderlich: true if night driving is required/mentioned.
- erkannte_strassen: list of road identifiers found (e.g. ["A3", "A40", "B8"]).
- ki_zusammenfassung: one short German sentence summarizing the permit.

Rules for "auflagen":
- Group related conditions into ONE entry per topic.
- Use prefixes: [Fahrtzeit], [Begleitung], [Geschwindigkeit], [Strecke], [Fahrzeug], [Behörde], [Sonstiges]
- Keep each entry SHORT: max 1-2 sentences.

Rules for "strecke":
- Extract as short waypoints: ["A3 AS Frankfurt-Süd", "B8 Richtung Hanau", ...], not full sentences.

Rules for "autobahnen":
- Extract ONLY Autobahn identifiers from the route section, NORMALIZED (remove spaces): "A 57" → "A57", "A57" stays "A57".
- Result: ["A57", "A42", "A3", "A2", "A1"] — ordered as they appear in the route.

Rules for "bundesstrassen":
- Extract ONLY Bundesstraßen identifiers, NORMALIZED: "B 75" → "B75".
- Result: ["B75"]

Rules for "kreisstrassen":
- Extract ONLY Kreisstraßen (K-roads), NORMALIZED: "K 20" → "K20".
- Result: ["K20"]

Rules for "anschlussstellen":
- Extract interchange and junction names: "Anschlussstelle", "AS", "Autobahnkreuz", "AK", "Autobahndreieck", "AD".
- Include the full name: "AS Krefeld Gartenstadt", "AK Kamp Lintfort", "AD Hamburg Südost".
- Result: ["AS Krefeld Gartenstadt", "AK Kamp Lintfort", ...]

Rules for "strassen_sequenz":
- Ordered list of ALL roads from start to end as they appear in the route description.
- Include ALL road types: local streets, Autobahnen, Bundesstraßen, Kreisstraßen.
- Result: ["Siempelkampstraße", "Hülser Str.", "A57", "A42", "A3", "A2", "A1", ...]

Rules for "strecke_volltext":
- Copy the COMPLETE route description text verbatim from the document (the section with Start/Ziel and road names).
- null if no route text found.

Rules for "auflagen_volltext":
- Copy the COMPLETE conditions/requirements section verbatim from the document.
- null if no conditions section found.

Rules for "start_location_name":
- Text in curly braces {} found after the start address, e.g. "{Siempelkamp Gießerei}" → "Siempelkamp Gießerei".
- null if not found.

Rules for "ziel_location_name":
- Text in curly braces {} found after the destination address.
- null if not found.

JSON schema:
{
  "dateiname": null,
  "genehmigungsnummer": null,
  "antragsnummer": null,
  "genehmigungsart": null,
  "kunde": null,
  "startort": null,
  "start_bundesland": null,
  "start_location_name": null,
  "zielort": null,
  "ziel_bundesland": null,
  "ziel_location_name": null,
  "gueltig_von": null,
  "gueltig_bis": null,
  "fahrzeug_laenge_m": null,
  "fahrzeug_breite_m": null,
  "fahrzeug_hoehe_m": null,
  "gesamtgewicht_t": null,
  "achslast_t": null,
  "kennzeichen": [],
  "strecke": [],
  "erkannte_strassen": [],
  "autobahnen": [],
  "bundesstrassen": [],
  "kreisstrassen": [],
  "anschlussstellen": [],
  "strassen_sequenz": [],
  "strecke_volltext": null,
  "auflagen_volltext": null,
  "auflagen": [],
  "behoerden": [],
  "besonderheiten": [],
  "begleitfahrzeug_erforderlich": false,
  "polizei_erforderlich": false,
  "nachtfahrt_erforderlich": false,
  "ki_zusammenfassung": null,
  "confidence": 0,
  "status": "needs_review"
}

Document:
"""

EMPTY_PERMIT = {
    "dateiname": None, "genehmigungsnummer": None, "antragsnummer": None,
    "genehmigungsart": None, "kunde": None, "startort": None,
    "start_bundesland": None, "start_location_name": None,
    "zielort": None, "ziel_bundesland": None, "ziel_location_name": None,
    "gueltig_von": None, "gueltig_bis": None,
    "fahrzeug_laenge_m": None, "fahrzeug_breite_m": None,
    "fahrzeug_hoehe_m": None, "gesamtgewicht_t": None, "achslast_t": None,
    "kennzeichen": [], "strecke": [], "erkannte_strassen": [],
    "autobahnen": [], "bundesstrassen": [], "kreisstrassen": [],
    "anschlussstellen": [], "strassen_sequenz": [],
    "strecke_volltext": None, "auflagen_volltext": None,
    "auflagen": [], "behoerden": [], "besonderheiten": [],
    "begleitfahrzeug_erforderlich": False, "polizei_erforderlich": False,
    "nachtfahrt_erforderlich": False, "ki_zusammenfassung": None,
    "confidence": 0.0, "status": "needs_review",
}


def extract_permit_data(text: str, filename: str) -> dict:
    result = {**EMPTY_PERMIT, "dateiname": filename}
    try:
        dispatch = {
            "mistral": _extract_mistral,
            "ollama":  _extract_ollama,
            "openai":  _extract_openai,
            "azure":   _extract_azure,
        }
        fn = dispatch.get(AI_PROVIDER, _extract_anthropic)
        result = fn(text, filename)
        result["dateiname"] = filename
        result.setdefault("status", "needs_review")
    except Exception as e:
        result["status"] = "error"
        result["besonderheiten"] = [f"Extraction error: {e}"]
    return result


def _parse_response(raw: str, filename: str) -> dict:
    raw = raw.strip()
    # Strip markdown code fences
    if "```" in raw:
        raw = re.sub(r"^```(?:json)?\s*", "", raw)
        raw = re.sub(r"\s*```\s*$", "", raw)
        raw = raw.strip()
    # Find the JSON object if there's preamble text (e.g. Mistral explanations)
    match = re.search(r"\{.*\}", raw, re.DOTALL)
    if match:
        raw = match.group(0)
    data = json.loads(raw)
    data["dateiname"] = filename
    data.setdefault("status", "needs_review")
    return data


def _extract_anthropic(text: str, filename: str) -> dict:
    import anthropic
    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    r = client.messages.create(
        model=ANTHROPIC_MODEL,
        max_tokens=4096,
        messages=[{"role": "user", "content": EXTRACTION_PROMPT + text[:50000]}],
    )
    return _parse_response(r.content[0].text, filename)


def _extract_openai(text: str, filename: str) -> dict:
    from openai import OpenAI
    client = OpenAI(api_key=OPENAI_API_KEY)
    r = client.chat.completions.create(
        model=OPENAI_MODEL,
        messages=[{"role": "user", "content": EXTRACTION_PROMPT + text[:50000]}],
        max_tokens=4096,
        store=False,
    )
    return _parse_response(r.choices[0].message.content, filename)


def _extract_azure(text: str, filename: str) -> dict:
    from openai import AzureOpenAI
    client = AzureOpenAI(
        api_key=AZURE_OPENAI_API_KEY,
        azure_endpoint=AZURE_OPENAI_ENDPOINT,
        api_version=AZURE_OPENAI_VERSION,
    )
    r = client.chat.completions.create(
        model=AZURE_OPENAI_DEPLOY,
        messages=[{"role": "user", "content": EXTRACTION_PROMPT + text[:50000]}],
        max_tokens=4096,
    )
    return _parse_response(r.choices[0].message.content, filename)


def _extract_mistral(text: str, filename: str) -> dict:
    from openai import OpenAI
    client = OpenAI(base_url="https://api.mistral.ai/v1", api_key=MISTRAL_API_KEY)
    r = client.chat.completions.create(
        model=MISTRAL_MODEL,
        messages=[{"role": "user", "content": EXTRACTION_PROMPT + text[:50000]}],
        max_tokens=4096,
        temperature=0.0,
    )
    return _parse_response(r.choices[0].message.content, filename)


def _extract_ollama(text: str, filename: str) -> dict:
    from openai import OpenAI
    client = OpenAI(base_url=OLLAMA_BASE_URL, api_key="ollama")
    r = client.chat.completions.create(
        model=OLLAMA_MODEL,
        messages=[{"role": "user", "content": EXTRACTION_PROMPT + text[:50000]}],
        max_tokens=4096,
        temperature=0.0,
        extra_body={"format": "json"},
    )
    return _parse_response(r.choices[0].message.content, filename)


def get_model_name() -> str:
    if AI_PROVIDER == "mistral":
        return f"mistral/{MISTRAL_MODEL}"
    if AI_PROVIDER == "ollama":
        return f"ollama/{OLLAMA_MODEL}"
    if AI_PROVIDER == "azure":
        return f"azure/{AZURE_OPENAI_DEPLOY}"
    if AI_PROVIDER == "openai":
        return f"openai/{OPENAI_MODEL}"
    return f"anthropic/{ANTHROPIC_MODEL}"
