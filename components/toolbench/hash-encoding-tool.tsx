"use client";

import * as React from "react";
import { FileUp } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  base32ToBytes,
  base64ToBytes,
  bytesToBase32,
  bytesToBase64,
  bytesToHex,
  bytesToUtf8,
  hexToBytes,
  utf8ToBytes,
} from "@/lib/toolbench/bytes";
import { ANY_FILE_GATE, checkFileSize, formatBytes } from "@/lib/toolbench/files";
import {
  HASH_ALGORITHMS,
  HASH_NOTE,
  HASH_STANDING,
  type HashAlgorithm,
  hashAll,
} from "@/lib/toolbench/hashing";
import { decodeJwt, validityState } from "@/lib/toolbench/jwt";
import { toAllFormats } from "@/lib/toolbench/time";
import {
  bruteForceSingleByteXor,
  rot47,
  rotN,
  urlDecode,
  urlEncode,
  xorBytes,
  type UrlEncodingMode,
} from "@/lib/toolbench/text-transforms";
import { Announcer, useAnnounce } from "./announcer";
import { FieldError, OutputRow, ToolPanel } from "./output-row";

/**
 * The hash and encoding workbench.
 *
 * Everything runs on bytes the browser already holds. The file path uses `File.arrayBuffer`
 * and never a network request, which is what lets the page promise that a source's file does
 * not leave the machine — and the promise is only worth making because there is no code here
 * that could break it.
 */

function HashPanel() {
  const announce = useAnnounce();
  const [text, setText] = React.useState("");
  const [digests, setDigests] = React.useState<Readonly<Record<HashAlgorithm, string>> | null>(null);
  const [source, setSource] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    if (text.length === 0) {
      setDigests(null);
      setSource(null);
      return;
    }
    void hashAll(utf8ToBytes(text)).then((result) => {
      if (cancelled) return;
      setDigests(result);
      setSource(`${text.length} characters of text`);
      setError(null);
      announce("Digests updated for the text you typed.");
    });
    return () => {
      cancelled = true;
    };
  }, [text, announce]);

  const onFile = React.useCallback(
    async (file: File) => {
      const size = checkFileSize(file.size, ANY_FILE_GATE);
      if (!size.ok) {
        setError(size.error);
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const result = await hashAll(bytes);
        setDigests(result);
        setText("");
        setSource(`${file.name} — ${formatBytes(file.size)}`);
        announce(`Digests computed for ${file.name}.`);
      } catch {
        setError("That file could not be read. If it is on a network drive, copy it locally first.");
      } finally {
        setBusy(false);
      }
    },
    [announce],
  );

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <ToolPanel
        title="Input"
        description="Type text, or pick a file. The file is read in this tab and is not uploaded."
      >
        <div className="space-y-4">
          <div>
            <Label htmlFor="hash-text">Text</Label>
            <Textarea
              id="hash-text"
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="Paste text to hash"
              className="mt-1.5 font-mono"
              spellCheck={false}
            />
          </div>

          <div>
            <Label htmlFor="hash-file">File</Label>
            <div className="mt-1.5 flex items-center gap-3">
              <Input
                id="hash-file"
                type="file"
                className="h-11 py-2 file:mr-3 file:rounded file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-sm"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void onFile(file);
                }}
              />
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">
              Up to {formatBytes(ANY_FILE_GATE.maxBytes)}. A large file is hashed in one pass
              and will hold the tab for a moment.
            </p>
          </div>

          {error !== null ? <FieldError>{error}</FieldError> : null}
        </div>
      </ToolPanel>

      <ToolPanel
        title="Digests"
        description={
          source === null
            ? "Nothing to hash yet."
            : `Computed from ${source}. Write the SHA-256 into your notes with the date and time you received the file.`
        }
      >
        {busy ? (
          <p className="text-sm text-muted-foreground">Reading the file…</p>
        ) : digests === null ? (
          <p className="text-sm text-muted-foreground">
            Digests appear here as you type or when you choose a file.
          </p>
        ) : (
          <div>
            {HASH_ALGORITHMS.map((algorithm) => (
              <OutputRow
                key={algorithm}
                label={algorithm}
                value={digests[algorithm]}
                hint={HASH_STANDING[algorithm] === "sound" ? undefined : "do not rely on this"}
                tone={HASH_STANDING[algorithm] === "sound" ? "default" : "warning"}
                note={HASH_NOTE[algorithm]}
              />
            ))}
          </div>
        )}
      </ToolPanel>
    </div>
  );
}

type EncodingFormat = "utf8" | "hex" | "base64" | "base64url" | "base32";

const ENCODING_LABELS: Readonly<Record<EncodingFormat, string>> = {
  utf8: "Text (UTF-8)",
  hex: "Hex",
  base64: "Base64",
  base64url: "Base64url",
  base32: "Base32 (RFC 4648)",
};

function EncodingPanel() {
  const announce = useAnnounce();
  const [format, setFormat] = React.useState<EncodingFormat>("utf8");
  const [value, setValue] = React.useState("");

  const decoded = React.useMemo(() => {
    if (value.length === 0) return { ok: true as const, value: new Uint8Array(0) };
    switch (format) {
      case "utf8":
        return { ok: true as const, value: utf8ToBytes(value) };
      case "hex":
        return hexToBytes(value);
      case "base64":
      case "base64url":
        return base64ToBytes(value);
      case "base32":
        return base32ToBytes(value);
    }
  }, [format, value]);

  React.useEffect(() => {
    if (value.length === 0) return;
    announce(decoded.ok ? `Decoded ${decoded.value.length} bytes.` : `Input rejected: ${decoded.error}`);
  }, [decoded, value.length, announce]);

  const bytes = decoded.ok ? decoded.value : null;
  const asText = bytes === null ? null : bytesToUtf8(bytes);

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <ToolPanel
        title="Input"
        description="Say what you are giving it, and every other encoding of the same bytes appears alongside."
      >
        <fieldset>
          <legend className="text-sm font-medium">Input is</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {(Object.keys(ENCODING_LABELS) as EncodingFormat[]).map((option) => (
              <label
                key={option}
                className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-md border border-input px-3 text-sm has-[:checked]:border-primary has-[:checked]:bg-accent"
              >
                <input
                  type="radio"
                  name="encoding-format"
                  value={option}
                  checked={format === option}
                  onChange={() => setFormat(option)}
                  className="size-4 accent-[var(--primary)]"
                />
                {ENCODING_LABELS[option]}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="mt-4">
          <Label htmlFor="encoding-input">Value</Label>
          <Textarea
            id="encoding-input"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            className="mt-1.5 font-mono"
            spellCheck={false}
            aria-invalid={!decoded.ok}
            aria-describedby={decoded.ok ? undefined : "encoding-error"}
            placeholder={format === "hex" ? "de ad be ef" : "Paste the value"}
          />
          {!decoded.ok ? (
            <p id="encoding-error" role="alert" className="mt-2 text-sm text-destructive">
              {decoded.error}
            </p>
          ) : null}
        </div>
      </ToolPanel>

      <ToolPanel title="The same bytes, written every other way">
        {bytes === null || bytes.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing decoded yet.</p>
        ) : (
          <div>
            <OutputRow label="Length" value={`${bytes.length} bytes`} copyLabel="the byte length" />
            <OutputRow
              label="Text (UTF-8)"
              value={asText?.ok === true ? asText.value : "These bytes are not valid UTF-8 text."}
              tone={asText?.ok === true ? "default" : "muted"}
              copyLabel="the decoded text"
            />
            <OutputRow label="Hex" value={bytesToHex(bytes)} />
            <OutputRow label="Base64" value={bytesToBase64(bytes)} />
            <OutputRow
              label="Base64url"
              value={bytesToBase64(bytes, { urlSafe: true })}
              hint="no padding"
              note="The alphabet JWTs and URL parameters use: - and _ instead of + and /."
            />
            <OutputRow label="Base32" value={bytesToBase32(bytes)} />
            <OutputRow
              label="URL encoded"
              value={asText?.ok === true ? urlEncode(asText.value) : "not applicable to non-text bytes"}
              tone={asText?.ok === true ? "default" : "muted"}
              copyLabel="the URL-encoded text"
            />
          </div>
        )}
      </ToolPanel>
    </div>
  );
}

function UrlPanel() {
  const [mode, setMode] = React.useState<UrlEncodingMode>("component");
  const [value, setValue] = React.useState("");
  const decoded = urlDecode(value, mode);

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <ToolPanel
        title="Percent encoding"
        description="Three modes, because they escape different characters and picking the wrong one is how a URL parameter arrives mangled."
      >
        <div>
          <Label htmlFor="url-mode">Mode</Label>
          <select
            id="url-mode"
            value={mode}
            onChange={(event) => setMode(event.target.value as UrlEncodingMode)}
            className="mt-1.5 h-11 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="component">Component — escapes everything a value may not contain</option>
            <option value="uri">Whole URI — keeps the characters that give a URL its structure</option>
            <option value="form">Form — like component, but a space becomes +</option>
          </select>
        </div>
        <div className="mt-4">
          <Label htmlFor="url-value">Value</Label>
          <Textarea
            id="url-value"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            className="mt-1.5 font-mono"
            spellCheck={false}
            placeholder="https://example.com/a b?q=1&r=2"
          />
        </div>
      </ToolPanel>

      <ToolPanel title="Both directions at once">
        {value.length === 0 ? (
          <p className="text-sm text-muted-foreground">Type something to see it both ways.</p>
        ) : (
          <div>
            <OutputRow label="Encoded" value={urlEncode(value, mode)} />
            <OutputRow
              label="Decoded"
              value={decoded.ok ? decoded.value : decoded.error}
              tone={decoded.ok ? "default" : "warning"}
              copyLabel="the decoded value"
            />
          </div>
        )}
      </ToolPanel>
    </div>
  );
}

function JwtPanel() {
  const [token, setToken] = React.useState("");
  const decoded = token.trim().length === 0 ? null : decodeJwt(token);

  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm">
        <p className="font-medium text-foreground">This decodes. It does not verify.</p>
        <p className="mt-1 leading-relaxed text-foreground-secondary">
          A signature can only be checked with the key that made it, and this tool does not
          have that key and will never ask for one. Everything below is what the token
          <em> says</em> about itself. Anyone can write a token claiming anything, so a
          decoded claim is a starting point for a question, never an answer to one.
        </p>
      </div>

      <ToolPanel
        title="Token"
        description="Pasted here, it stays here. A live token pasted into a public decoder website is a credential you have given away."
      >
        <Label htmlFor="jwt-token" className="sr-only">
          JWT
        </Label>
        <Textarea
          id="jwt-token"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          className="min-h-32 font-mono text-xs"
          spellCheck={false}
          aria-invalid={decoded !== null && !decoded.ok}
          placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
        />
        {decoded !== null && !decoded.ok ? <FieldError>{decoded.error}</FieldError> : null}
      </ToolPanel>

      {decoded !== null && decoded.ok ? (
        <div className="grid gap-5 lg:grid-cols-2">
          <ToolPanel title="Header">
            <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">
              {JSON.stringify(decoded.value.header, null, 2)}
            </pre>
            {decoded.value.isUnsecured ? (
              <p role="alert" className="mt-3 text-sm leading-relaxed text-destructive">
                The algorithm is <code className="font-mono">none</code>. That is a real,
                specified value and also the oldest JWT vulnerability: a server that honours
                it accepts a token anybody can write. Where you found this matters.
              </p>
            ) : null}
          </ToolPanel>

          <ToolPanel title="Payload">
            <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">
              {JSON.stringify(decoded.value.payload, null, 2)}
            </pre>
          </ToolPanel>

          <ToolPanel title="Claims worth reading" className="lg:col-span-2">
            <div>
              <OutputRow label="Algorithm" value={decoded.value.alg ?? "not stated"} />
              <OutputRow label="Key id (kid)" value={decoded.value.kid ?? "not stated"} />
              <OutputRow label="Issuer (iss)" value={decoded.value.issuer ?? "not stated"} />
              <OutputRow label="Subject (sub)" value={decoded.value.subject ?? "not stated"} />
              <OutputRow
                label="Audience (aud)"
                value={decoded.value.audience.length > 0 ? decoded.value.audience.join(", ") : "not stated"}
              />
              {(
                [
                  ["Issued at (iat)", decoded.value.times.iat],
                  ["Not before (nbf)", decoded.value.times.nbf],
                  ["Expires (exp)", decoded.value.times.exp],
                ] as const
              ).map(([label, seconds]) => (
                <OutputRow
                  key={label}
                  label={label}
                  value={
                    seconds === null
                      ? "not stated"
                      : `${seconds} — ${toAllFormats(new Date(seconds * 1000)).iso8601}`
                  }
                  tone={seconds === null ? "muted" : "default"}
                />
              ))}
              <OutputRow
                label="Window"
                value={
                  {
                    expired: "Already expired at the time on your machine right now.",
                    notYetValid: "Not yet valid at the time on your machine right now.",
                    withinWindow: "Inside its stated window at the time on your machine right now.",
                    noWindowStated: "The token states no validity window at all.",
                  }[validityState(decoded.value.times)]
                }
                copyLabel="the validity summary"
                note="Read against your own clock, and against claims the token makes about itself. Neither is independently trustworthy."
              />
              <OutputRow
                label="Signature (not checked)"
                value={decoded.value.signature.length > 0 ? decoded.value.signature : "(empty)"}
                tone="muted"
                copyLabel="the signature segment"
              />
            </div>
          </ToolPanel>
        </div>
      ) : null}
    </div>
  );
}

function ObfuscationPanel() {
  const [text, setText] = React.useState("");
  const [shift, setShift] = React.useState(13);
  const [xorKey, setXorKey] = React.useState("");
  const [xorKeyIsHex, setXorKeyIsHex] = React.useState(false);
  const [xorInputIsHex, setXorInputIsHex] = React.useState(false);

  const xorInput = xorInputIsHex ? hexToBytes(text) : { ok: true as const, value: utf8ToBytes(text) };
  const xorKeyBytes = xorKeyIsHex ? hexToBytes(xorKey) : { ok: true as const, value: utf8ToBytes(xorKey) };
  const xored =
    xorInput.ok && xorKeyBytes.ok && xorKeyBytes.value.length > 0
      ? xorBytes(xorInput.value, xorKeyBytes.value)
      : null;

  const xoredText = React.useMemo(() => {
    if (xored === null || !xored.ok) return null;
    const asText = bytesToUtf8(xored.value);
    return {
      isText: asText.ok,
      text: asText.ok ? asText.value : "These bytes are not valid UTF-8 text.",
      hex: bytesToHex(xored.value),
    };
  }, [xored]);

  const candidates =
    xorInput.ok && xorInput.value.length > 0 && xorKey.length === 0
      ? bruteForceSingleByteXor(xorInput.value, 5)
      : [];

  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-border bg-muted/40 p-4 text-sm leading-relaxed text-foreground-secondary">
        Neither of these is encryption and neither offers any confidentiality. They are here
        because obfuscated strings turn up constantly in malware configuration, phishing kits
        and lazily hidden values, and being able to unwrap one in five seconds is the
        difference between following a lead and dropping it.
      </div>

      <ToolPanel title="Input">
        <Label htmlFor="obfuscation-text">Value</Label>
        <Textarea
          id="obfuscation-text"
          value={text}
          onChange={(event) => setText(event.target.value)}
          className="mt-1.5 font-mono"
          spellCheck={false}
          placeholder="Paste the obfuscated string"
        />
      </ToolPanel>

      <div className="grid gap-5 lg:grid-cols-2">
        <ToolPanel title="ROT-n" description="A Caesar shift over the 26 ASCII letters.">
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <Label htmlFor="rot-shift">Shift</Label>
              <Input
                id="rot-shift"
                type="number"
                min={-25}
                max={25}
                value={shift}
                onChange={(event) => setShift(Number(event.target.value) || 0)}
                className="mt-1.5 h-11"
              />
            </div>
            <Button type="button" variant="secondary" className="h-11" onClick={() => setShift(13)}>
              ROT13
            </Button>
          </div>
          <div className="mt-4">
            <OutputRow label={`ROT-${((shift % 26) + 26) % 26}`} value={rotN(text, shift)} />
            <OutputRow
              label="ROT47"
              value={rot47(text)}
              note="Rotates all 94 printable ASCII characters, so digits and punctuation move too. Its own inverse."
            />
          </div>
        </ToolPanel>

        <ToolPanel title="XOR" description="Repeating-key XOR, and a brute force over every single-byte key.">
          <div className="space-y-3">
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={xorInputIsHex}
                onChange={(event) => setXorInputIsHex(event.target.checked)}
                className="size-4 accent-[var(--primary)]"
              />
              Input above is hex, not text
            </label>
            <div>
              <Label htmlFor="xor-key">Key</Label>
              <Input
                id="xor-key"
                value={xorKey}
                onChange={(event) => setXorKey(event.target.value)}
                className="mt-1.5 h-11 font-mono"
                placeholder="Leave empty to brute force every single-byte key"
              />
            </div>
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={xorKeyIsHex}
                onChange={(event) => setXorKeyIsHex(event.target.checked)}
                className="size-4 accent-[var(--primary)]"
              />
              Key is hex
            </label>
          </div>

          {!xorInput.ok ? <FieldError>{xorInput.error}</FieldError> : null}
          {!xorKeyBytes.ok ? <FieldError>{xorKeyBytes.error}</FieldError> : null}

          {xoredText !== null ? (
            <div className="mt-4">
              <OutputRow
                label="Result (text)"
                value={xoredText.text}
                tone={xoredText.isText ? "default" : "muted"}
                copyLabel="the XOR result as text"
              />
              <OutputRow label="Result (hex)" value={xoredText.hex} copyLabel="the XOR result as hex" />
            </div>
          ) : null}

          {candidates.length > 0 ? (
            <div className="mt-4">
              <p className="text-sm font-medium">
                Most printable single-byte keys
                <span className="ml-2 font-normal text-muted-foreground">
                  ranked, not decided
                </span>
              </p>
              <ul className="mt-2 space-y-2">
                {candidates.map((candidate) => (
                  <li key={candidate.key} className="rounded-md border border-border p-2">
                    <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                      <span className="font-mono">
                        key 0x{candidate.key.toString(16).padStart(2, "0")}
                      </span>
                      <span>{Math.round(candidate.printableRatio * 100)}% printable</span>
                    </div>
                    <code className="mt-1 block break-all font-mono text-xs">
                      {candidate.preview || "(empty)"}
                    </code>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </ToolPanel>
      </div>
    </div>
  );
}

export function HashEncodingTool() {
  return (
    <Announcer>
      <Tabs defaultValue="hashes">
        <TabsList className="flex-wrap">
          <TabsTrigger value="hashes">
            <FileUp className="size-4" aria-hidden="true" />
            Hashes
          </TabsTrigger>
          <TabsTrigger value="encodings">Encodings</TabsTrigger>
          <TabsTrigger value="url">URL</TabsTrigger>
          <TabsTrigger value="jwt">JWT</TabsTrigger>
          <TabsTrigger value="obfuscation">ROT and XOR</TabsTrigger>
        </TabsList>

        <TabsContent value="hashes">
          <HashPanel />
        </TabsContent>
        <TabsContent value="encodings">
          <EncodingPanel />
        </TabsContent>
        <TabsContent value="url">
          <UrlPanel />
        </TabsContent>
        <TabsContent value="jwt">
          <JwtPanel />
        </TabsContent>
        <TabsContent value="obfuscation">
          <ObfuscationPanel />
        </TabsContent>
      </Tabs>
    </Announcer>
  );
}
