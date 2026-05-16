"""Shared AI caller — wraps the configured provider, returns raw response text."""
import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / ".env", override=True)

AI_PROVIDER = os.getenv("AI_PROVIDER", "anthropic")
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
ANTHROPIC_MODEL = os.getenv("ANTHROPIC_MODEL", "claude-opus-4-7")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o")
AZURE_OPENAI_API_KEY = os.getenv("AZURE_OPENAI_API_KEY", "")
AZURE_OPENAI_ENDPOINT = os.getenv("AZURE_OPENAI_ENDPOINT", "")
AZURE_OPENAI_DEPLOY = os.getenv("AZURE_OPENAI_DEPLOYMENT", "")
AZURE_OPENAI_VERSION = os.getenv("AZURE_OPENAI_API_VERSION", "2024-08-01-preview")
OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434/v1")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "qwen2.5:14b")
MISTRAL_API_KEY = os.getenv("MISTRAL_API_KEY", "")
MISTRAL_MODEL = os.getenv("MISTRAL_MODEL", "mistral-large-latest")


def call_ai(prompt: str, max_tokens: int = 4096) -> str:
    dispatch = {
        "mistral": _call_mistral,
        "ollama": _call_ollama,
        "openai": _call_openai,
        "azure": _call_azure,
    }
    fn = dispatch.get(AI_PROVIDER, _call_anthropic)
    return fn(prompt, max_tokens)


def _call_anthropic(prompt: str, max_tokens: int) -> str:
    import anthropic
    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    r = client.messages.create(
        model=ANTHROPIC_MODEL,
        max_tokens=max_tokens,
        messages=[{"role": "user", "content": prompt}],
    )
    return r.content[0].text


def _call_openai(prompt: str, max_tokens: int) -> str:
    from openai import OpenAI
    client = OpenAI(api_key=OPENAI_API_KEY)
    r = client.chat.completions.create(
        model=OPENAI_MODEL,
        messages=[{"role": "user", "content": prompt}],
        max_tokens=max_tokens,
        store=False,
    )
    return r.choices[0].message.content


def _call_azure(prompt: str, max_tokens: int) -> str:
    from openai import AzureOpenAI
    client = AzureOpenAI(
        api_key=AZURE_OPENAI_API_KEY,
        azure_endpoint=AZURE_OPENAI_ENDPOINT,
        api_version=AZURE_OPENAI_VERSION,
    )
    r = client.chat.completions.create(
        model=AZURE_OPENAI_DEPLOY,
        messages=[{"role": "user", "content": prompt}],
        max_tokens=max_tokens,
    )
    return r.choices[0].message.content


def _call_mistral(prompt: str, max_tokens: int) -> str:
    from openai import OpenAI
    client = OpenAI(base_url="https://api.mistral.ai/v1", api_key=MISTRAL_API_KEY)
    r = client.chat.completions.create(
        model=MISTRAL_MODEL,
        messages=[{"role": "user", "content": prompt}],
        max_tokens=max_tokens,
        temperature=0.0,
    )
    return r.choices[0].message.content


def _call_ollama(prompt: str, max_tokens: int) -> str:
    from openai import OpenAI
    client = OpenAI(base_url=OLLAMA_BASE_URL, api_key="ollama")
    r = client.chat.completions.create(
        model=OLLAMA_MODEL,
        messages=[{"role": "user", "content": prompt}],
        max_tokens=max_tokens,
        temperature=0.0,
        extra_body={"format": "json"},
    )
    return r.choices[0].message.content
