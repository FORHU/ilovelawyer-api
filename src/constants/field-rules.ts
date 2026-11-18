/**
 * What a firm's details and a Lawyer Application's fields may hold. The lawyer app applies the same
 * rules as the lawyer types (ilovelawyer-app's lib/forms/field-rules.ts), so a value it lets through
 * is never refused here.
 */

/** A phone number: digits and spaces, with an optional "+" in front for the country code. */
export const PHONE_PATTERN = /^\+?[0-9 ]+$/;
export const PHONE_MIN_DIGITS = 7;
export const PHONE_MAX_DIGITS = 15;

/** Registration, firm, Roll and IBP membership numbers: digits only. */
export const DIGITS_PATTERN = /^[0-9]+$/;
/** The longest registration, firm or Roll number. */
export const NUMBER_MAX_DIGITS = 10;

/** A place or a name (a city, an IBP chapter, a language): letters in any language, spaces and
 * . - ' ( ). Never digits. */
export const WORDS_PATTERN = /^[\p{L}\p{M} .'’()-]+$/u;

/** An MCLE compliance number, e.g. VII-0012345. */
export const MCLE_NUMBER_PATTERN = /^[A-Za-z0-9-]+$/;
/** An MCLE compliance period, e.g. VII. */
export const ROMAN_NUMERAL_PATTERN = /^[IVXLCDMivxlcdm]+$/;

export const UK_POSTCODE_PATTERN = /^[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}$/i;
export const PH_ZIP_CODE_PATTERN = /^\d{4}$/;
/** A Korean postcode (우편번호): 5 digits since 2015. */
export const KR_POSTCODE_PATTERN = /^\d{5}$/;

/** What a KR firm is (KR only, optional): 법무법인, 법무법인(유한), 법무조합, 공동법률사무소, or a
 * lawyer's own office (개인 법률사무소). */
export const KR_FIRM_TYPES = ["LAW_FIRM", "LAW_FIRM_LLC", "LAW_PARTNERSHIP", "JOINT_OFFICE", "SOLE_OFFICE"] as const;

/** Whether ten digits are a valid Korean business registration number (사업자등록번호, shown as
 * 123-45-67890): the last digit is a check digit over the first nine. */
export function isKrBusinessRegistrationNumber(value: string): boolean {
  if (!/^\d{10}$/.test(value)) return false;
  const d = [...value].map(Number);
  const weights = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  let sum = weights.reduce((acc, w, i) => acc + d[i] * w, 0);
  sum += Math.floor((d[8] * 5) / 10);
  return (10 - (sum % 10)) % 10 === d[9];
}
