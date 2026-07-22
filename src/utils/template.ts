import fs from "fs";
import path from "path";
import mjml2html from "mjml";
import handlebars from "handlebars";

export async function renderTemplate(name: string, vars: Record<string, string>): Promise<string> {
  const filePath = path.join(__dirname, "../templates", `${name}.mjml`);
  const source = fs.readFileSync(filePath, "utf-8");
  const mjmlSource = handlebars.compile(source)(vars);

  const { html, errors } = await mjml2html(mjmlSource);
  if (errors.length) {
    throw new Error(errors.map((e) => e.message).join(", "));
  }

  return html;
}
