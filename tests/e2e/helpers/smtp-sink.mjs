/**
 * A local stand-in for Mailpit when Docker isn't available: SMTP on 1025, the three Mailpit
 * HTTP endpoints `helpers/mail.ts` uses on 8025. Prefer real Mailpit when you can.
 *
 * Not a mail server: accepts anything, keeps it in memory, relays nothing, loopback only.
 *
 *   node tests/e2e/helpers/smtp-sink.mjs
 */
import { createServer as createTcpServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { randomUUID } from "node:crypto";

const SMTP_PORT = Number(process.env.SINK_SMTP_PORT ?? 1025);
const HTTP_PORT = Number(process.env.SINK_HTTP_PORT ?? 8025);
const HOST = "127.0.0.1";

/** @type {{ID:string, Created:string, From:{Address:string}, To:{Address:string}[], Subject:string, Text:string, HTML:string, Raw:string}[]} */
const messages = [];

/** Decode the quoted-printable and base64 that nodemailer uses for the parts we read. */
function decodeBody(body, encoding) {
  const value = (encoding ?? "").toLowerCase();
  if (value === "base64") {
    return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
  }
  if (value === "quoted-printable") {
    return body
      .replace(/=\r?\n/g, "")
      .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  }
  return body;
}

/** Approximate MIME parsing: headers, multipart split, per-part decoding. */
function parse(raw) {
  const split = raw.indexOf("\r\n\r\n");
  const headerBlock = split < 0 ? raw : raw.slice(0, split);
  const body = split < 0 ? "" : raw.slice(split + 4);

  const unfolded = headerBlock.replace(/\r\n[ \t]+/g, " ");
  const header = (name) => {
    const match = new RegExp(`^${name}:\s*(.*)$`, "im").exec(unfolded);
    return match?.[1]?.trim() ?? "";
  };
  const address = (value) => /<([^>]+)>/.exec(value)?.[1] ?? value.trim();

  const contentType = header("Content-Type");
  const boundary = /boundary="?([^";]+)"?/i.exec(contentType)?.[1];

  let text = "";
  let html = "";
  if (boundary) {
    for (const part of body.split(`--${boundary}`)) {
      const cut = part.indexOf("\r\n\r\n");
      if (cut < 0) continue;
      const partHeaders = part.slice(0, cut);
      const decoded = decodeBody(
        part.slice(cut + 4),
        /Content-Transfer-Encoding:\s*(\S+)/i.exec(partHeaders)?.[1],
      );
      if (/Content-Type:\s*text\/html/i.test(partHeaders)) html = decoded;
      else if (/Content-Type:\s*text\/plain/i.test(partHeaders)) text = decoded;
    }
  } else {
    const decoded = decodeBody(body, header("Content-Transfer-Encoding"));
    if (/text\/html/i.test(contentType)) html = decoded;
    else text = decoded;
  }

  return {
    ID: randomUUID(),
    Created: new Date().toISOString(),
    From: { Address: address(header("From")) },
    To: header("To").split(",").filter(Boolean).map((one) => ({ Address: address(one) })),
    Subject: header("Subject"),
    Text: text,
    HTML: html,
    Raw: raw,
  };
}

createTcpServer((socket) => {
  let buffer = "";
  let collecting = false;
  let data = "";

  const say = (line) => socket.write(`${line}\r\n`);
  say("220 smtp-sink ESMTP ready");

  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");

    for (;;) {
      if (collecting) {
        const terminator = buffer.indexOf("\r\n.\r\n");
        if (terminator < 0) return;
        data += buffer.slice(0, terminator);
        buffer = buffer.slice(terminator + 5);
        collecting = false;
        messages.push(parse(data));
        data = "";
        say("250 2.0.0 Ok: queued");
        continue;
      }

      const end = buffer.indexOf("\r\n");
      if (end < 0) return;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const verb = line.split(" ")[0]?.toUpperCase() ?? "";

      if (verb === "EHLO") {
        // No STARTTLS advertised, so nodemailer sends in the clear (loopback only).
        say("250-smtp-sink");
        say("250-AUTH PLAIN LOGIN");
        say("250-8BITMIME");
        say("250 SIZE 10485760");
      } else if (verb === "HELO") say("250 smtp-sink");
      else if (verb === "AUTH") say("235 2.7.0 Accepted");
      else if (verb === "MAIL") say("250 2.1.0 Ok");
      else if (verb === "RCPT") say("250 2.1.5 Ok");
      else if (verb === "RSET") say("250 2.0.0 Ok");
      else if (verb === "NOOP") say("250 2.0.0 Ok");
      else if (verb === "QUIT") {
        say("221 2.0.0 Bye");
        socket.end();
        return;
      } else if (verb === "DATA") {
        collecting = true;
        say("354 End data with <CR><LF>.<CR><LF>");
      } else say("250 2.0.0 Ok");
    }
  });

  socket.on("error", () => socket.destroy());
}).listen(SMTP_PORT, HOST, () => process.stdout.write(`smtp-sink: SMTP on ${HOST}:${SMTP_PORT}
`));

createHttpServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}:${HTTP_PORT}`);
  const json = (body) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  if (req.method === "DELETE" && url.pathname === "/api/v1/messages") {
    messages.length = 0;
    return json({});
  }
  if (url.pathname === "/api/v1/messages") {
    // Newest first, as Mailpit returns them.
    const ordered = [...messages].reverse();
    return json({ total: ordered.length, count: ordered.length, messages: ordered });
  }
  const one = /^\/api\/v1\/message\/(.+)$/.exec(url.pathname);
  if (one) {
    const found = messages.find((message) => message.ID === one[1]);
    if (!found) {
      res.writeHead(404).end();
      return;
    }
    return json(found);
  }
  res.writeHead(404).end();
}).listen(HTTP_PORT, HOST, () => process.stdout.write(`smtp-sink: API on http://${HOST}:${HTTP_PORT}
`));
