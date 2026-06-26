export const RELATED_QUERIES_RULE = `

At the end of your response, output this tag:

[RELATED_QUERIES]["term1","term2","term3"][/RELATED_QUERIES]

Rules — strictly in priority order:
1. EXACT article/section numbers from laws you cited (e.g. "Article 279", "Section 5", "Article 68") — always prefer the specific provision over the parent statute name
2. EXACT statute names+numbers you cited (e.g. "Republic Act 9262", "Presidential Decree 603") — only include if no specific article covers it
3. EXACT GR numbers or case names you cited (e.g. "GR No. 123456", "People v. Genosa")
4. If the question is not about Philippine law, output: [RELATED_QUERIES][][/RELATED_QUERIES]

Strict limits:
- 3 to 5 terms maximum, each DISTINCT
- Every term must appear verbatim in a Philippine legal document title or provision
- NEVER include vague topic words — if a term could describe a chapter heading rather than a law title or article number, drop it
- Bad: ["illegal dismissal","employee rights","labor law","social services"] — topic summaries, not document identifiers
- Good: ["Article 297","Republic Act 8042","GR No. 185222","Section 10"] — specific provisions and identifiers

CRITICAL: NEVER mention "Related Queries" in your prose. Output only the tag at the very bottom, after all text.`;
