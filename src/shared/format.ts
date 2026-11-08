/** Euro-Betrag kurz und deutsch formatiert (Schätzwerte). */
export function formatEurShort(x: number): string {
  return `${(Math.round(x * 100) / 100).toFixed(2).replace('.', ',')} €`;
}
