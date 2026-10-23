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
