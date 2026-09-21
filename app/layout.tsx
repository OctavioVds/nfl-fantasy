import type { Metadata } from "next";
import { Inter, Oswald, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-body" });
const oswald = Oswald({ subsets: ["latin"], variable: "--font-display" });
const mono = IBM_Plex_Mono({ weight: ["400", "500", "600"], subsets: ["latin"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "NFL Fantasy Command Center",
  description: "Decisiones Fantasy explicables, con fuentes, estado y protección contra datos vencidos.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es">
      <body className={`${inter.variable} ${oswald.variable} ${mono.variable}`}>{children}</body>
    </html>
  );
}
