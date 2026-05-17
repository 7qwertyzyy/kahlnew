"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Sun, Moon } from "lucide-react";
import { api } from "@/lib/api";

const NAV_ITEMS = [
  { href: "/", label: "Dashboard" },
  { href: "/planer", label: "Streckenplaner" },
  { href: "/genehmigungen", label: "Genehmigungen" },
  { href: "/anfrage", label: "Anfragen" },
];

export default function Navigation() {
  const pathname = usePathname();
  const [openAnfragen, setOpenAnfragen] = useState(0);
  const [darkMode, setDarkMode] = useState(false);

  useEffect(() => {
    api.getAnfragenStats()
      .then((stats) => setOpenAnfragen(stats.neu + stats.in_bearbeitung))
      .catch(() => setOpenAnfragen(0));
  }, []);

  useEffect(() => {
    const stored = localStorage.getItem("theme");
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const isDark = stored ? stored === "dark" : prefersDark;
    document.documentElement.classList.toggle("dark", isDark);
    Promise.resolve().then(() => setDarkMode(isDark));
  }, []);

  function toggleTheme() {
    const next = !darkMode;
    setDarkMode(next);
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("theme", next ? "dark" : "light");
  }

  return (
    <nav className="flex items-center gap-3 bg-gray-900 border-b border-gray-700 px-6 h-16 shrink-0">
      <Link href="/" className="flex items-center gap-3 mr-6 shrink-0">
        <Image
          src="/logo.png"
          alt="Kahl Schwerlast"
          width={160}
          height={50}
          priority
          className="brand-logo h-10 w-auto object-contain"
        />
      </Link>

      <div className="flex items-center gap-1 flex-1 min-w-0 overflow-x-auto">
        {NAV_ITEMS.map(({ href, label }) => {
          const active =
            href === "/" ? pathname === "/" : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
                active
                  ? "bg-blue-600 text-white"
                  : "text-gray-300 hover:bg-gray-700 hover:text-white"
              }`}
            >
              {label}
              {href === "/anfrage" && openAnfragen > 0 && (
                <span className="ml-2 rounded-full bg-red-600 px-1.5 py-0.5 text-[10px] leading-none text-white">
                  {openAnfragen}
                </span>
              )}
            </Link>
          );
        })}
      </div>

      {/* Dark Mode Toggle */}
      <button
        type="button"
        onClick={toggleTheme}
        aria-label={darkMode ? "Light Mode aktivieren" : "Dark Mode aktivieren"}
        title={darkMode ? "Light Mode" : "Dark Mode"}
        className="nav-theme-toggle relative flex h-8 w-[52px] shrink-0 items-center rounded-full p-1 transition-colors duration-200"
      >
        <span
          className={`nav-theme-thumb flex h-6 w-6 items-center justify-center rounded-full shadow-sm transition-transform duration-200 ${
            darkMode ? "translate-x-[20px]" : "translate-x-0"
          }`}
        >
          {darkMode
            ? <Moon size={12} className="text-white" />
            : <Sun size={12} className="text-white" />
          }
        </span>
      </button>
    </nav>
  );
}
