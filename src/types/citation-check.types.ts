export interface ResolvedAuthority {
  lawId: string;
  title: string;
  jurisUrl: string;
}

export interface ResolvedCitationAuthority {
  lawId: string | null;
  confidence: number | null;
  authority: ResolvedAuthority | null;
  /** The cited section of a UK Act, so its text can be fetched (#364). */
  ukSection?: string | null;
}
