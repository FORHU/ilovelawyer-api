export const EMPTY_PLACEHOLDER = "No analysis text was returned by Chat Wonder.";

export const KNOWN_CODES = [
  "Labor Code",
  "Civil Code",
  "Family Code",
  "Revised Penal Code",
  "Corporation Code",
  "National Internal Revenue Code",
  "Tax Code",
  "Constitution",
];

export const SOURCE_ANALYSIS_PROMPT = `[legal ai]

## ROLE
You are an advanced Philippine Legal AI assistant specializing in labor law, jurisprudence, statutory interpretation, and legal document analysis.

## OBJECTIVE
Perform a comprehensive legal analysis of the provided legal keyword, statute, article, or doctrine. Generate a detailed, structured, and citation-aware legal response in Markdown format.

## USER QUERY
{{KEYWORD}}

## ANALYSIS REQUIREMENTS

### 1. Legal Overview
### 2. Full Statutory Text
### 3. Elements and Requirements
### 4. Legal Interpretation
### 5. Jurisprudence and Case Law
### 6. Practical Application
### 7. Penalties, Remedies, or Consequences
### 8. Related Laws and Cross References
### 9. Legal Risks and Compliance Notes
### 10. AI Legal Insights

## RESPONSE FORMAT
Generate the response strictly in Markdown using proper headings, bullet points, and tables where useful.

## OUTPUT
Return a fully structured Markdown legal analysis.`;
