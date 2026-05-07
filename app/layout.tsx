import "./globals.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Карта жалоб на дороги — Томск",
  description:
    "Прототип анализа текстовых жалоб о дорогах Томска и визуализации на OpenStreetMap.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
