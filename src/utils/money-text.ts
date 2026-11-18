/** "£10.00", "₩20,000": an amount of minor units in its own currency (KRW has no decimals). */
export function moneyText(minor: number, currency: string): string {
  const decimals = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  return (minor / 10 ** decimals).toLocaleString(currency === "KRW" ? "ko-KR" : "en-GB", { style: "currency", currency });
}
