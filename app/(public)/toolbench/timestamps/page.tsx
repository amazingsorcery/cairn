import { notFound } from "next/navigation";

import { TimestampTool } from "@/components/toolbench/timestamp-tool";
import { ToolPage } from "@/components/toolbench/tool-page";
import { pageMetadata } from "@/lib/metadata";
import { findTool } from "@/lib/toolbench/registry";

const entry = findTool("timestamps");

export const metadata = pageMetadata({
  title: "Timestamp and time-zone converter",
  description:
    "Convert between Unix seconds and milliseconds, ISO 8601, Windows FILETIME, WebKit, Mac absolute time, HFS+ and MS-DOS packed values, across any IANA time zone.",
  path: "/toolbench/timestamps",
});

export default function TimestampsPage() {
  if (entry === null) notFound();

  return (
    <ToolPage
      entry={entry}
      technique={
        <>
          <p>
            A timestamp is a count of intervals since a zero point. Everything else about it —
            which zero, how large the intervals, and whether a time zone was recorded — is a
            decision somebody made decades ago in a system you are now reading the output of.
          </p>
          <p>
            The epochs differ by orders of magnitude, which is what makes reading an
            unlabelled value tractable. Unix time counts seconds from 1970. Windows FILETIME
            counts 100-nanosecond intervals from 1601, which puts a present-day value around
            1.3 &times; 10<sup>17</sup>. Chrome&apos;s history database counts microseconds
            from the same 1601 epoch. Apple&apos;s CFAbsoluteTime counts seconds from 2001,
            and HFS+ counts them from 1904. Read a FILETIME as Unix seconds and you place the
            event four billion years in the future, which is at least an obvious error; read a
            Mac absolute time as Unix seconds and you place it in 1995, which is not.
          </p>
          <p>
            The second panel exists for the case where nobody wrote down what a value is. It
            reads the same digits under every epoch and shows which readings land between 1980
            and 2100. Usually one does. Where two do, both are shown, because picking one for
            you would be a guess presented as an answer.
          </p>
          <p>
            Time zones are applied from this browser&apos;s own IANA database at the instant in
            question, so a July timestamp and a January one in the same zone correctly differ
            by an hour.
          </p>
        </>
      }
      limits={
        <>
          <p>
            <strong className="text-foreground">Most of these formats carry no time
            zone.</strong> Every numeric epoch above is an instant in UTC. When a source
            records local time with no offset — a FAT directory entry, an EXIF{" "}
            <code className="font-mono text-sm">DateTimeOriginal</code> without{" "}
            <code className="font-mono text-sm">OffsetTimeOriginal</code> — the zone is missing
            from the evidence, not from this tool, and no conversion can recover it. Treating
            such a value as UTC is a choice you are making, and it should appear in your notes
            as one.
          </p>
          <p>
            <strong className="text-foreground">A recorded time is a claim about a
            clock.</strong> Camera clocks are unset, wrong or drifting as a matter of routine.
            Server clocks are usually good; a phone that has been offline for a week may not
            be. A timestamp is evidence of what a device believed, and the device can be wrong
            without anybody lying.
          </p>
          <p>
            <strong className="text-foreground">Unix time ignores leap seconds.</strong> It is
            not elapsed SI seconds since 1970. For ordinary investigative work this is
            immaterial; for sub-second reasoning across a leap-second boundary it is not.
          </p>
          <p>
            <strong className="text-foreground">Precision below a millisecond is
            dropped.</strong> FILETIME resolves to 100 nanoseconds and WebKit to a
            microsecond; a JavaScript date does not. Where that happens the tool says exactly
            how much was discarded rather than quietly rounding.
          </p>
          <p>
            <strong className="text-foreground">MS-DOS values are two-second
            resolution.</strong> An odd second cannot be represented, so a ZIP entry made at
            14:05:09 stores 14:05:08. Do not read a one-second discrepancy between a ZIP entry
            and another source as a discrepancy.
          </p>
        </>
      }
      workedExample={
        <>
          <p>
            You are reading an NTFS master file table entry and the creation time is recorded
            as <code className="font-mono text-sm">133200000000000000</code>. Paste it and the
            guess panel resolves it in one step. Unix seconds does not appear at all: that many
            seconds is four billion years, outside the range a date can even represent. The
            WebKit reading is offered and struck through, because it lands in the year 5821. As
            a Windows FILETIME it is{" "}
            <strong className="text-foreground">2023-02-04 16:00:00 UTC</strong>, which is a
            date a file could plausibly have been created on.
          </p>
          <p>
            Select FILETIME and the rest of the conversion follows: 1675526400 as Unix seconds,
            for the log platform that wants that, and the wall-clock table underneath tells you
            it was 11:00 in New York and 16:00 in London — which is what you need if the next
            document in the bundle is an email sent from an office in one of them.
          </p>
          <p>
            Later in the same investigation a Chrome{" "}
            <code className="font-mono text-sm">History</code> database gives you{" "}
            <code className="font-mono text-sm">13350000000000000</code> for a visit. Same
            1601 epoch, microseconds rather than 100-nanosecond ticks:{" "}
            <strong className="text-foreground">2024-01-17 21:20:00 UTC</strong>. Reading it as
            a FILETIME would have put it in 1643, which the guess panel would have shown you
            struck through before you wrote it down.
          </p>
        </>
      }
    >
      <TimestampTool />
    </ToolPage>
  );
}
