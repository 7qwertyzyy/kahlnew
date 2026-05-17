import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const GLYPH_HOST = "https://fonts.openmaptiles.org";

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ fontstack: string; range: string }> }
) {
  const { fontstack, range } = await context.params;
  if (!fontstack || !range) {
    return new NextResponse("Invalid glyph request", { status: 400 });
  }

  const candidates = String(fontstack)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  const chosenFont = candidates[0];
  if (!chosenFont) {
    return new NextResponse("Invalid glyph request", { status: 400 });
  }

  const upstream = `${GLYPH_HOST}/${encodeURIComponent(chosenFont)}/${encodeURIComponent(range)}`;
  return NextResponse.redirect(upstream, {
    status: 307,
    headers: {
      "Cache-Control": "public, max-age=86400, s-maxage=2592000, stale-while-revalidate=2592000",
    },
  });
}
