"use client";

import { useActionState, useEffect, useId, useState } from "react";
import { useFormStatus } from "react-dom";
import { TriangleAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { requestMagicLink } from "./actions";
import { IDLE_SIGNIN_STATE, type SignInFormState } from "./signin-state";

/**
 * Magic-link form; a client leaf for validation, pending state and the rate-limit countdown.
 * Validates on blur, not per keystroke; the server re-checks with the same schema. The
 * field keeps its value through failures (the action echoes the address back).
 */

function formatCountdown(msRemaining: number): string {
  const total = Math.max(0, Math.ceil(msRemaining / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function SubmitButton({ disabled, countdown }: { disabled: boolean; countdown: string | null }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" className="w-full" disabled={disabled || pending}>
      {pending ? "sending…" : "email a sign-in link"}
      {countdown ? <span className="tabular"> ({countdown})</span> : null}
    </Button>
  );
}

export function SignInForm({ callbackUrl }: { callbackUrl: string }) {
  const [state, formAction] = useActionState<SignInFormState, FormData>(
    requestMagicLink,
    IDLE_SIGNIN_STATE,
  );

  const fieldId = useId();
  const errorId = useId();

  const [value, setValue] = useState("");
  const [touchedError, setTouchedError] = useState<string | null>(null);
  const [now, setNow] = useState<number | null>(null);

  const serverEmail = state.status === "idle" ? null : state.email;

  // Re-seed the field from the server's echo after a failed submit, so nothing typed is
  // lost across the round trip.
  useEffect(() => {
    if (serverEmail) setValue(serverEmail);
  }, [serverEmail]);

  const rateLimitedUntil =
    state.status === "rateLimited" ? new Date(state.resetAt).getTime() : null;

  useEffect(() => {
    if (rateLimitedUntil === null) {
      setNow(null);
      return;
    }
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [rateLimitedUntil]);

  const msRemaining = rateLimitedUntil !== null && now !== null ? rateLimitedUntil - now : 0;
  const stillLimited = msRemaining > 0;
  const minutesRemaining = Math.max(1, Math.ceil(msRemaining / 60_000));

  const invalidMessage = state.status === "invalidEmail" ? state.message : touchedError;
  const describedBy = invalidMessage ? errorId : undefined;

  return (
    <form action={formAction} className="mt-6 flex flex-col gap-4" noValidate>
      <input type="hidden" name="callbackUrl" value={callbackUrl} />

      {state.status === "rateLimited" ? (
        <Alert variant="warning">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>Too many sign-in links requested</AlertTitle>
          <AlertDescription>
            <p>
              Wait {minutesRemaining} {minutesRemaining === 1 ? "minute" : "minutes"} before
              asking for another. If one already arrived, it still works.
            </p>
          </AlertDescription>
        </Alert>
      ) : null}

      {state.status === "sendFailed" ? (
        <Alert variant="destructive">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>The link wasn&rsquo;t sent</AlertTitle>
          <AlertDescription>
            <p>Nothing left our side. Try again in a minute, or use another sign-in method.</p>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={fieldId}>email</Label>
        <Input
          id={fieldId}
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="you@example.org"
          className="h-11 font-mono"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            if (touchedError) setTouchedError(null);
          }}
          onBlur={(event) => {
            const candidate = event.target.value.trim();
            if (candidate === "") {
              setTouchedError(null);
              return;
            }
            // Deliberately loose: the server schema is the gate. This only catches the
            // shapes a human can see are wrong.
            const looksLikeAddress = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate);
            setTouchedError(
              looksLikeAddress
                ? null
                : "That doesn't look like an email address. Check it and try again.",
            );
          }}
          aria-invalid={invalidMessage ? true : undefined}
          aria-describedby={describedBy}
        />
        {invalidMessage ? (
          <p id={errorId} className="text-xs text-destructive">
            {invalidMessage}
          </p>
        ) : null}
      </div>

      <SubmitButton
        disabled={stillLimited}
        countdown={stillLimited ? formatCountdown(msRemaining) : null}
      />
    </form>
  );
}
