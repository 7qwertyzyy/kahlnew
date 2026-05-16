"""
PDF text extraction: optional Docling first, then PyMuPDF fallback.
"""


def extract_text(pdf_path: str) -> str:
    try:
        from docling.document_converter import DocumentConverter

        converter = DocumentConverter()
        result = converter.convert(pdf_path)
        text = result.document.export_to_markdown()
        if text.strip():
            return text
    except ImportError:
        pass
    except Exception:
        pass

    try:
        import fitz

        doc = fitz.open(pdf_path)
        pages = [page.get_text() for page in doc]
        doc.close()
        return "\n\n".join(pages)
    except Exception as e:
        return f"[ERROR] {e}"
