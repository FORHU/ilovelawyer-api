export interface ResolvedAuthority {
  lawId: string;
  title: string;
  jurisUrl: string;
}

export interface ResolvedCitationAuthority {
  lawId: string | null;
  confidence: number | null;
  authority: ResolvedAuthority | null;
}
