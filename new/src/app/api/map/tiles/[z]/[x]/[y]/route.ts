import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const TILE_HOSTS = [
  "https://a.tile.openstreetmap.org",
  "https://b.tile.openstreetmap.org",
  "https://c.tile.openstreetmap.org",
];

function pickHost(x: number, y: number, z: number) {
  const idx = Math.abs((x * 31 + y * 17 + z * 13) % TILE_HOSTS.length);
  return TILE_HOSTS[idx];
}

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ z: string; x: string; y: string }> }
) {
  const { z, x, y } = await context.params;
  const zi = Number(z);
  const xi = Number(x);
  const yi = Number(y);

  if (![zi, xi, yi].every(Number.isInteger) || zi < 0 || xi < 0 || yi < 0) {
    return new NextResponse("Invalid tile coordinates", { status: 400 });
  }

  const upstream = `${pickHost(xi, yi, zi)}/${zi}/${xi}/${yi}.png`;
  const res = await fetch(upstream, {
    headers: {
      Accept: "image/png,image/*;q=0.8,*/*;q=0.5",
      "User-Agent": "schwertransport-planer-mvp/0.1",
    },
    next: { revalidate: 60 * 60 * 24 * 7 },
  });

  if (!res.ok) {
    return new NextResponse("Tile upstream failed", { status: 502 });
  }

  const body = await res.arrayBuffer();
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": res.headers.get("content-type") || "image/png",
      "Cache-Control": "public, max-age=86400, s-maxage=604800, stale-while-revalidate=604800",
    },
  });
}
