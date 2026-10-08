import fs from "fs";
import path from "path";
import mjml2html from "mjml";
import handlebars from "handlebars";

const TEMPLATES_DIR = path.join(__dirname, "../templates");

/** The header logo travels inside the email as an inline (CID) attachment — sendEmail attaches
 * it whenever the html references it. A hosted URL would break in local dev (an inbox can't
 * reach localhost) and wherever CLIENT_URL[0] isn't the site actually serving the asset. */
export const LOGO_CID = "ilovelawyer-logo";
export const LOGO_PATH = path.join(TEMPLATES_DIR, "assets/ilovelawyer-lockup-dark.png");

function readTemplate(name: string): string {
  return fs.readFileSync(path.join(TEMPLATES_DIR, `${name}.mjml`), "utf-8");
}

/**
 * Renders `templates/<name>.mjml` — a fragment of mjml content (mj-text, mj-button, ...) —
 * inside the shared branded `_layout.mjml` (header logo, card, footer).
 *
 * The dark lockup (light-colored logo) is used because it sits on the layout's dark header band;
 * it's embedded via LOGO_CID rather than linked.
 */
export async function renderTemplate(name: string, vars: Record<string, string>): Promise<string> {
  const content = handlebars.compile(readTemplate(name))(vars);

  const layoutVars = {
    logoSrc: `cid:${LOGO_CID}`,
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
