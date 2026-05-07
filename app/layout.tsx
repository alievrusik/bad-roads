import "./globals.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Карта жалоб на дороги — Томск",
  description:
    "Прототип анализа текстовых жалоб о дорогах Томска и визуализации на карте Leaflet / Esri (резерв CARTO).",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
