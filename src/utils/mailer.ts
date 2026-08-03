import { SendMailOptions, createTransport, getTestMessageUrl } from "nodemailer";
import { MAILER_FROM, MAILER_TRANSPORT_HOST, MAILER_TRANSPORT_PORT, MAILER_TRANSPORT_SECURE, MAILER_EMAIL, MAILER_PASSWORD, isDev } from "../config";

export async function sendEmail({ to, subject, text, html }: { to: string; subject: string; text?: string; html?: string }): Promise<string> {
  const transporter = createTransport({
    host: MAILER_TRANSPORT_HOST,
    port: MAILER_TRANSPORT_PORT,
    secure: MAILER_TRANSPORT_SECURE,
    auth: {
      user: MAILER_EMAIL,
      pass: MAILER_PASSWORD,
    },
  });

  const from = MAILER_FROM;
  const mailOptions: SendMailOptions = {
    from: isDev ? `[TEST] ilovelawyer <${from}>` : `ilovelawyer <${from}>`,
    to,
    subject: isDev ? `[TEST] ${subject}` : subject,
  };

  if (text) {
    mailOptions.text = text;
  }

  if (html) {
    mailOptions.html = html;
  }

  try {
    const info = await transporter.sendMail(mailOptions);

    const previewUrl = getTestMessageUrl(info);
    if (previewUrl) console.log(`[mailer] Preview email: ${previewUrl}`);

    return Promise.resolve("Email sent successfully");
  } catch (error) {
    return Promise.reject(error);
  }
}
