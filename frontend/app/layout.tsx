import type { Metadata } from "next";
import "./globals.css";
import "@mapbox/mapbox-gl-geocoder/dist/mapbox-gl-geocoder.css";
import Navigation from "@/components/shared/Navigation";

export const metadata: Metadata = {
  title: "Kahl Route & Permit Intelligence",
  description: "Routenplanung und Genehmigungs-Management für Schwertransporte",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="de" className="h-full" suppressHydrationWarning>
      <head>
        <script
          suppressHydrationWarning
          dangerouslySetInnerHTML={{
            __html:
              "try{var t=localStorage.getItem('theme');var d=t?t==='dark':window.matchMedia('(prefers-color-scheme: dark)').matches;document.documentElement.classList.toggle('dark',d)}catch(e){}",
          }}
        />
      </head>
      <body className="app-body h-full flex flex-col" suppressHydrationWarning>
        <Navigation />
        <main className="flex-1 overflow-hidden">{children}</main>
      </body>
    </html>
  );
}
