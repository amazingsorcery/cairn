import { notFound } from "next/navigation";

import { HashEncodingTool } from "@/components/toolbench/hash-encoding-tool";
import { ToolPage } from "@/components/toolbench/tool-page";
import { pageMetadata } from "@/lib/metadata";
import { findTool } from "@/lib/toolbench/registry";

const entry = findTool("hashes-and-encodings");

export const metadata = pageMetadata({
  title: "Hash and encoding workbench",
  description:
    "SHA-1 to SHA-512 and MD5 over text or a file, base64, base32 and hex, URL encoding, JWT decoding, ROT-n and XOR — all computed in your own browser.",
  path: "/toolbench/hashes-and-encodings",
});

export default function HashesAndEncodingsPage() {
  if (entry === null) notFound();

  return (
    <ToolPage
      entry={entry}
      technique={
        <>
          <p>
            A cryptographic hash reduces any quantity of bytes to a short fixed-length value
            that changes completely if a single bit of the input changes. That is what makes
            it the identity of a file: two people in different places can compute the same
            digest from the same bytes and know they are holding the same thing, without
            sending the file to each other.
          </p>
          <p>
            SHA-1 through SHA-512 come from WebCrypto, the browser&apos;s own native
            implementation. MD5 is implemented here because WebCrypto deliberately refuses to
            provide it; it is included because investigators meet it constantly in material
            they did not choose — malware sample sets, VirusTotal and MISP records, old
            evidence logs — and being unable to reproduce a hash somebody else published is a
            real obstacle.
          </p>
          <p>
            The encodings are a different job. Base64, base32, hex and percent-encoding do not
            hide anything and are not meant to: they exist so that arbitrary bytes can travel
            through channels that only carry text. Recognising which one you are looking at,
            and unwrapping it, is a constant low-level task in reading tokens, configuration
            blobs and URLs.
          </p>
          <p>
            The JWT tab splits a token into its three segments and decodes the first two. The
            third — the signature — is displayed and never checked, because checking it
            requires the key that produced it.
          </p>
        </>
      }
      limits={
        <>
          <p>
            <strong className="text-foreground">MD5 and SHA-1 are broken.</strong> Collisions
            can be constructed on ordinary hardware for both, so two <em>different</em> files
            can share a digest. Only the negative half of the answer survives: a different
            hash does mean different bytes. Never write an MD5 or SHA-1 into a case file as
            the identity of a piece of evidence. Use SHA-256.
          </p>
          <p>
            <strong className="text-foreground">A hash proves integrity, not
            provenance.</strong> It says the bytes you have now are the bytes you had then. It
            says nothing about where they came from, who made them, or whether the picture
            inside them is real. A hash computed after a file passed through a messaging app
            is the identity of the app&apos;s re-encode, not of the original.
          </p>
          <p>
            <strong className="text-foreground">A decoded JWT is not a verified JWT.</strong>{" "}
            Anybody can mint a token containing any claims they like. A decoded{" "}
            <code className="font-mono text-sm">&quot;role&quot;: &quot;admin&quot;</code>{" "}
            tells you what the token says, never what is true. If a token you found decodes to{" "}
            <code className="font-mono text-sm">alg: none</code>, that is a finding about the
            system that issued it, not a licence to trust its contents.
          </p>
          <p>
            <strong className="text-foreground">ROT-n and XOR are not encryption.</strong>{" "}
            Text you unwrap with them was never protected, and text you wrap with them is not
            protected either. The brute-force list ranks candidate keys by how printable the
            output is; on short input, or input that is not text, the correct key will often
            not be first.
          </p>
        </>
      }
      workedExample={
        <>
          <p>
            A source sends you a photograph over Signal. Before anything else, you save it and
            drop it into the Hashes tab. The SHA-256 comes back as a 64-character value; you
            paste it into your notes with the date, the time and the time zone, and a line
            saying who sent it and when.
          </p>
          <p>
            Three weeks later the source says they sent you a different version by mistake.
            You hash the file you have again. If the digest matches your note, the file has
            not changed on your side and the question is about what they sent, not about what
            you did with it. If it does not match, you have a problem worth finding before
            anyone else does.
          </p>
          <p>
            Separately, a domain in the same investigation redirects through a URL containing{" "}
            <code className="font-mono text-sm">eyJ1IjoiaHR0cHM6Ly9leGFtcGxlLmludmFsaWQvIn0</code>.
            Set the Encodings tab to Base64url and paste it: the bytes decode to{" "}
            <code className="font-mono text-sm">
              {'{"u":"https://example.invalid/"}'}
            </code>
            , which is the redirect target, recoverable without visiting the link and telling
            the operator you looked.
          </p>
        </>
      }
    >
      <HashEncodingTool />
    </ToolPage>
  );
}
