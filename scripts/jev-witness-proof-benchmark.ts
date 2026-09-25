/**
 * Benchmark for the witness "what's needed" proof check (src/utils/witness-need-proof-jev.ts).
 *
 * Every case is a requirement (the wording the scorer produces) plus an invented document text and
 * the verdict a lawyer would give it: SATISFIES, PARTLY or NONE. All names, banks and records are
 * fictional. A SATISFIES or PARTLY proof should be accepted, a NONE proof refused, and only a real
 * SATISFIES should ever read as "Matches".
 *
 * Run: npx ts-node scripts/jev-witness-proof-benchmark.ts   (needs TYPESAFE_API_KEY)
 */
import * as dotenv from "dotenv";
dotenv.config();
import { checkProofWithJev, toStoredMatch } from "../src/utils/witness-need-proof-jev";

type Label = "SATISFIES" | "PARTLY" | "NONE";
interface Case {
  id: string;
  label: Label;
  requirement: string;
  name: string;
  text: string;
}

const REQ = {
  bankDates:
    "Obtain the dates on which the underlying bank entries were created and the dates on which Salazar reviewed or extracted them.",
  ledger:
    "Obtain authenticated Pacific Meridian records for the March enquiry, any sale or order record, and the relevant account ledger showing whether a £1.85 million payment was received.",
  invoiceFormats:
    "Obtain the March 2026 enquiry record, the relevant payment-ledger extract, and examples or records showing Pacific Meridian's invoice numbering and packing-list formats.",
  stepDates:
    "Obtain the dates on which the bank records were obtained, the laptop was examined, the online listing was located, and Reyes was interviewed.",
  forensic:
    "Obtain the underlying forensic report, bank-record schedule, preserved online-listing material and search record for the alleged customs notice.",
  reyesStatement:
    "Obtain a supplemental statement from Reyes setting out one clear account of the words he recalls, distinguishing remembered words from his interpretation of them.",
  reyesInterest:
    "Ask Reyes whether his social or business relationship with Garo involved any financial, personal or commercial interest connected with the transaction.",
  bankInterest:
    "Ask Salazar whether the bank has any financial, regulatory or commercial interest in the outcome beyond providing records.",
} as const;

const CASES: Case[] = [
  // --- bank entry dates
  { id: "bankDates-match", label: "SATISFIES", requirement: REQ.bankDates, name: "Bank_audit_log_extract.pdf",
    text: "Meridian Retail Bank - system audit log extract. Ledger entry 44712 was created automatically on 14 April 2026 at 09:12. Entry 44713 was created on 21 April 2026. The compliance officer V. Salazar extracted these entries on 2 July 2026 and reviewed them on 3 July 2026 before certifying the schedule." },
  { id: "bankDates-partial", label: "PARTLY", requirement: REQ.bankDates, name: "Bank_schedule_creation_dates.pdf",
    text: "Meridian Retail Bank - schedule of ledger entries. Entry 44712 was created on 14 April 2026. Entry 44713 was created on 21 April 2026. Entry 44714 was created on 28 April 2026. The schedule does not record when any entry was extracted or reviewed by staff." },
  { id: "bankDates-unrelated", label: "NONE", requirement: REQ.bankDates, name: "Bank_complaints_policy.pdf",
    text: "Meridian Retail Bank - customer complaints policy. Complaints about accounts should be raised with the branch manager within 30 days. The bank will acknowledge a complaint within 5 working days and issue a final response within 8 weeks. Customers may refer unresolved complaints to the Financial Ombudsman Service." },
  // --- supplier ledger / order records
  { id: "ledger-match", label: "SATISFIES", requirement: REQ.ledger, name: "Pacific_Meridian_certified_records.pdf",
    text: "Pacific Meridian Electronics Pte Ltd - certified records extract. Enquiry received 11 March 2026 from a contact using the name Marcus Garo regarding refurbished laptops. No sale or purchase order was raised. Account ledger 2026 Q1-Q2: no receipt of GBP 1,850,000 or any payment from Romano Digital Trading Ltd. Certified by the finance director." },
  { id: "ledger-partial", label: "PARTLY", requirement: REQ.ledger, name: "Pacific_Meridian_enquiry_email.pdf",
    text: "Email from Pacific Meridian Electronics sales desk, 11 March 2026: Thank you for your enquiry about refurbished business laptops. Please send your required quantities and we will respond with availability. This message records the enquiry only. No order, invoice or ledger information is attached." },
  { id: "ledger-unrelated", label: "NONE", requirement: REQ.ledger, name: "Pacific_Meridian_brochure.pdf",
    text: "Pacific Meridian Electronics Pte Ltd - product brochure. We refurbish and resell business laptops and monitors across Asia. Our warranty covers 12 months. Contact our sales desk for volume pricing. Registered office: Singapore." },
  // --- invoice numbering and packing list formats
  { id: "invoice-match", label: "SATISFIES", requirement: REQ.invoiceFormats, name: "Pacific_Meridian_invoice_samples.pdf",
    text: "Pacific Meridian Electronics - internal invoice register, 2026. Genuine invoices are numbered PM-2026-NNNNN in strict sequence, for example PM-2026-00412 dated 3 March 2026. Our standard packing list uses the header PACKING NOTE with a PM-PL reference and a three-column layout. The enquiry of 11 March 2026 is logged at reference ENQ-0311." },
  { id: "invoice-partial", label: "PARTLY", requirement: REQ.invoiceFormats, name: "Pacific_Meridian_invoice_format_note.pdf",
    text: "Note from Pacific Meridian finance: our invoices are numbered in the PM-2026 series in sequence. We do not attach sample invoices to this note and cannot comment on packing lists." },
  { id: "invoice-unrelated", label: "NONE", requirement: REQ.invoiceFormats, name: "Shipping_terms.pdf",
    text: "General shipping terms and conditions. Incoterms 2020 define the responsibilities of buyers and sellers for delivery. FOB means the seller delivers when goods are on board the vessel. Risk passes at that point. Insurance is arranged by the buyer under FOB terms." },
  // --- police dates
  { id: "stepDates-match", label: "SATISFIES", requirement: REQ.stepDates, name: "Investigation_chronology.pdf",
    text: "City of London Police - investigation chronology, DC Mendoza. Bank records obtained: 6 June 2026. Laptop examined at forensic unit: 9 June 2026. Online listing located and preserved: 12 June 2026. Nico Reyes interviewed: 15 June 2026." },
  { id: "stepDates-partial", label: "PARTLY", requirement: REQ.stepDates, name: "Investigation_chronology_partial.pdf",
    text: "City of London Police - investigation chronology, DC Mendoza. Bank records obtained: 6 June 2026. Laptop examined at forensic unit: 9 June 2026. The remaining steps have not yet been dated in this log." },
  { id: "stepDates-unrelated", label: "NONE", requirement: REQ.stepDates, name: "Police_press_release.pdf",
    text: "City of London Police press release. Officers have launched a campaign warning small businesses about invoice fraud. Advice includes checking supplier details independently and never paying to a new account without confirmation by phone." },
  // --- forensic report
  { id: "forensic-match", label: "SATISFIES", requirement: REQ.forensic, name: "Forensic_report_and_schedules.pdf",
    text: "Digital forensic report on the laptop seized from M. Garo. A PDF matching the disputed bill of lading was found with metadata dated 8 May 2026. Appendix A: bank-record schedule of four payments totalling GBP 1,850,000. Appendix B: preserved copy of the 2024 online listing and photographs. Appendix C: search record showing no customs notice was located for the alleged GBP 300,000 release demand." },
  { id: "forensic-partial", label: "PARTLY", requirement: REQ.forensic, name: "Forensic_summary.pdf",
    text: "Summary of digital forensic findings on the laptop seized from M. Garo. A PDF matching the disputed bill of lading was found with metadata dated 8 May 2026. The full technical report and appendices are not included in this summary." },
  { id: "forensic-unrelated", label: "NONE", requirement: REQ.forensic, name: "Laptop_purchase_receipt.pdf",
    text: "Receipt for the purchase of a business laptop from a retail shop on 2 February 2025. Price GBP 899. Payment by card. Two year warranty included. Keep this receipt as proof of purchase." },
  // --- Reyes supplemental statement
  { id: "reyesStatement-match", label: "SATISFIES", requirement: REQ.reyesStatement, name: "Reyes_supplemental_statement.pdf",
    text: "Supplemental statement of Nico Reyes, 20 July 2026. What I remember Garo saying, as closely as I can recall: 'I think Pacific Meridian is made up.' That is my memory of the words. My understanding of what he meant, which is my own interpretation and not something he said, is that the supplier might not exist. I cannot recall the exact date. Signed N. Reyes." },
  { id: "reyesStatement-partial", label: "PARTLY", requirement: REQ.reyesStatement, name: "Reyes_statement_note.pdf",
    text: "Supplemental note from Nico Reyes, 20 July 2026. I recall Garo saying something like 'Pacific Meridian is made up'. I am not sure of the precise wording. This note does not separate what I remember hearing from what I took it to mean." },
  { id: "reyesStatement-unrelated", label: "NONE", requirement: REQ.reyesStatement, name: "Reyes_gym_membership.pdf",
    text: "Membership agreement for Nico Reyes at a local gym. Monthly fee GBP 30. Cancellation requires 30 days notice in writing. Facilities include a pool and sauna." },
  // --- Reyes interest
  { id: "reyesInterest-match", label: "SATISFIES", requirement: REQ.reyesInterest, name: "Reyes_declaration_of_interest.pdf",
    text: "Declaration of Nico Reyes, 21 July 2026. I have known Marcus Garo socially for about five years. I have no financial interest in the laptop transaction, I have never lent him money or invested in his business, and I stand to gain nothing from the outcome of this case. Signed N. Reyes." },
  { id: "reyesInterest-partial", label: "PARTLY", requirement: REQ.reyesInterest, name: "Reyes_interest_note.pdf",
    text: "Note of a phone call with Nico Reyes, 21 July 2026. He confirmed he knows Marcus Garo socially. He was not asked about any financial or commercial connection and did not volunteer one." },
  { id: "reyesInterest-unrelated", label: "NONE", requirement: REQ.reyesInterest, name: "Reyes_travel_booking.pdf",
    text: "Flight booking confirmation for Nico Reyes, London to Manchester, 5 August 2026. Seat 14C. One cabin bag included. Check in opens 24 hours before departure." },
  // --- bank interest
  { id: "bankInterest-match", label: "SATISFIES", requirement: REQ.bankInterest, name: "Bank_conflict_declaration.pdf",
    text: "Meridian Retail Bank - declaration of interests by V. Salazar, compliance officer, 18 July 2026. The bank holds no financial, regulatory or commercial interest in the outcome of R v Garo other than acting as custodian of the account records. The bank is not a party and faces no regulatory action in connection with these accounts." },
  { id: "bankInterest-partial", label: "PARTLY", requirement: REQ.bankInterest, name: "Bank_regulatory_note.pdf",
    text: "Meridian Retail Bank internal note, 18 July 2026. The bank is not currently subject to any regulatory investigation relating to these accounts. The note does not address any financial or commercial interest of the bank in the outcome." },
  { id: "bankInterest-unrelated", label: "NONE", requirement: REQ.bankInterest, name: "Bank_opening_hours.pdf",
    text: "Meridian Retail Bank - branch opening hours. Monday to Friday 9am to 5pm, Saturday 9am to 1pm. Closed on Sundays and bank holidays. Cash machines are available 24 hours a day." },
];

interface Row {
  c: Case;
  verdict: string;
  confidence: number;
  refused: boolean;
}

async function main() {
  const t0 = Date.now();
  const rows: Row[] = await Promise.all(
    CASES.map(async (c) => {
      const r = await checkProofWithJev({
        requirement: c.requirement,
        document: { name: c.name, category: null, summary: null, text: c.text },
      });
      return { c, verdict: r.verdict, confidence: r.confidence, refused: toStoredMatch(r) === "REFUSE" };
    }),
  );
  console.log(`${rows.length} cases in ${Math.round((Date.now() - t0) / 1000)}s\n`);
  console.log("label      verdict           conf  decision   case");
  for (const r of rows) {
    console.log(
      `${r.c.label.padEnd(10)} ${r.verdict.padEnd(17)} ${r.confidence.toFixed(2)}  ${(r.refused ? "REFUSED" : "accepted").padEnd(9)}  ${r.c.id}`,
    );
  }

  const should = rows.filter((r) => r.c.label !== "NONE");
  const none = rows.filter((r) => r.c.label === "NONE");
  const falseRefusals = should.filter((r) => r.refused);
  const falseAccepts = none.filter((r) => !r.refused);
  console.log(`\nfalse refusals (match/partial refused): ${falseRefusals.length}/${should.length}`);
  falseRefusals.forEach((r) => console.log(`   ${r.c.id}  ${r.verdict} ${r.confidence.toFixed(2)}`));
  console.log(`false accepts (unrelated accepted):      ${falseAccepts.length}/${none.length}`);
  falseAccepts.forEach((r) => console.log(`   ${r.c.id}  ${r.verdict} ${r.confidence.toFixed(2)}`));

  console.log("\nconfirm threshold sweep (a proof reads as 'Matches' when verdict SATISFIES and confidence >= t):");
  for (const t of [0.5, 0.6, 0.7, 0.8, 0.9]) {
    const shown = rows.filter((r) => !r.refused && r.verdict === "SATISFIES" && r.confidence >= t);
    const right = shown.filter((r) => r.c.label === "SATISFIES");
    const wrong = shown.filter((r) => r.c.label !== "SATISFIES");
    const missed = rows.filter((r) => r.c.label === "SATISFIES" && !(r.verdict === "SATISFIES" && r.confidence >= t));
    console.log(
      `  t=${t.toFixed(1)}  shown ${shown.length}  correct ${right.length}  wrongly confirmed ${wrong.length}  true matches not confirmed ${missed.length}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
