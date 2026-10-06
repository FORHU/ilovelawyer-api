import fs from "fs";
import path from "path";
import mjml2html from "mjml";
import handlebars from "handlebars";
import { CLIENT_URL } from "../config";

const TEMPLATES_DIR = path.join(__dirname, "../templates");

function readTemplate(name: string): string {
  return fs.readFileSync(path.join(TEMPLATES_DIR, `${name}.mjml`), "utf-8");
}

/**
 * Renders `templates/<name>.mjml` — a fragment of mjml content (mj-text, mj-button, ...) —
 * inside the shared branded `_layout.mjml` (header logo, card, footer).
 *
 * The dark lockup (light-colored logo) is used because it sits on the layout's dark header band.
 * Callers can override `logoSrc` (e.g. to point at a tenant origin).
 */
export async function renderTemplate(name: string, vars: Record<string, string>): Promise<string> {
  const content = handlebars.compile(readTemplate(name))(vars);

  const layoutVars = {
    logoSrc: `${CLIENT_URL[0] ?? ""}/assets/logo/ilovelawyer-lockup-dark.png`,
    year: String(new Date().getFullYear()),
    ...vars,
    content,
  };
  const mjmlSource = handlebars.compile(readTemplate("_layout"))(layoutVars);

  const { html, errors } = await mjml2html(mjmlSource);
  if (errors.length) {
    throw new Error(errors.map((e) => e.message).join(", "));
  }

  return html;
}
